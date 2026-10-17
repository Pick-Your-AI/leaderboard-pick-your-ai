import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

export class ControlError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const requireThat = (value, status = 400, message = 'Invalid request') => {
  if (!value) throw new ControlError(status, message);
};
export const actorId = value => {
  requireThat(typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value));
  return value;
};
export function text(value, maximum = 2000) {
  requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= maximum);
  requireThat(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value));
  return value.trim();
}
export function locator(value) {
  const source = text(value, 2048);
  let url;
  try { url = new URL(source); } catch { throw new ControlError(400, 'Invalid locator'); }
  requireThat(url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.port);
  requireThat(/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/.+/.test(url.pathname));
  return url.href;
}
export function exactKeys(value, allowed) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value));
  requireThat(Object.keys(value).every(key => allowed.includes(key)), 400, 'Unexpected field');
}
const fresh = () => ({ sessions: {}, oauth: {}, profiles: {}, requests: {}, audit: [], revision: 0 });

// Only deliberately public fields enter this projection. No private reasons,
// requester receipts, opt-out flags, decision identities or session data escape.
export function projectPublic(state) {
  const visible = id => !state.profiles[id]?.suppressed;
  const profiles = Object.entries(state.profiles)
    .filter(([id, profile]) => visible(id) && profile.public)
    .map(([id, profile]) => ({ actorId: id, bio: profile.bio, highlights: profile.highlights }));
  const claims = Object.values(state.requests)
    .filter(r => r.kind === 'evidence' && r.status === 'accepted' && visible(r.owner))
    .map(r => ({ id: r.id, actorId: r.owner, locator: r.locator, category: r.category,
      scope: r.scope, policyVersion: r.policyVersion,
      collaborators: Object.entries(r.collaborators).filter(([id, consent]) => consent === 'accepted' && visible(id)).map(([id]) => id) }));
  return { revision: state.revision, profiles, claims };
}

export class ControlStore {
  constructor(filename, { transactionalPublisher } = {}) {
    requireThat(isAbsolute(filename), 500, 'An absolute private database path is required');
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    chmodSync(filename, 0o600);
    this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS controls_state (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL); CREATE TABLE IF NOT EXISTS controls_publication (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL);');
    this.db.prepare('INSERT OR IGNORE INTO controls_state VALUES(1,?)').run(JSON.stringify(fresh()));
    this.db.prepare('INSERT OR IGNORE INTO controls_publication VALUES(1,?)').run(JSON.stringify(projectPublic(fresh())));
    this.publisher = transactionalPublisher;
  }
  read() { return JSON.parse(this.db.prepare('SELECT document FROM controls_state WHERE id=1').get().document); }
  publicSnapshot() { return JSON.parse(this.db.prepare('SELECT document FROM controls_publication WHERE id=1').get().document); }
  transaction(change, { publish = false } = {}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.read();
      const result = change(state);
      requireThat(!result?.then, 500, 'Transactions must be synchronous');
      if (publish) {
        state.revision++;
        const snapshot = projectPublic(state);
        this.db.prepare('UPDATE controls_publication SET document=? WHERE id=1').run(JSON.stringify(snapshot));
        // Hook may write only through this SQLite transaction. Network/cache
        // side effects cannot be made atomic by calling them inside a callback.
        const output = this.publisher?.({ database: this.db, snapshot: structuredClone(snapshot) });
        requireThat(!output?.then, 500, 'Publisher must use the same synchronous database transaction');
      }
      this.db.prepare('UPDATE controls_state SET document=? WHERE id=1').run(JSON.stringify(state));
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() { this.db.close(); }
}

export function record(state, request, actor, action, now, details = {}) {
  request.version++;
  request.updatedAt = now;
  const event = { id: randomUUID(), receipt: request.id, actor, action, at: now, version: request.version, ...details };
  request.history.push(event);
  state.audit.push(event);
}

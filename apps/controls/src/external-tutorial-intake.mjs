import { createHash } from "node:crypto";
import { types } from "node:util";

export const externalTutorialIntakeVersion = "evidence-intake/external-tutorial/v1";
export const externalTutorialDeclarationVersion = "external-tutorial-declaration/v1";
export const externalTutorialTermsVersion = "evidence-terms/external-tutorial/2026-10-20";

const canonical = (value) =>
  JSON.stringify(value, function (_key, item) {
    if (item && typeof item === "object" && !Array.isArray(item))
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, item[key]]),
      );
    return item;
  });
const content = Object.freeze({
  schemaVersion: "evidence-terms/v1",
  version: externalTutorialTermsVersion,
  rightsPolicyVersion: "2026-10-18",
  paragraphs: Object.freeze([
    "This optional declaration identifies an external tutorial and a pinned GitHub evidence manifest. The manifest is the GitHub carrier; its authorship does not establish who authored the tutorial or who permits its use.",
    "Each listed participant sees the tutorial identity, exact revision and content hash, manifest pin, declared publication time and complete proposed account attribution. Consent covers that displayed declaration only. Unknown roles and publication time remain unknown.",
    "The service does not fetch the tutorial or verify the declaration. Private review details, source-use statements and reviewer rationale stay in the protected review workflow and are not shared in participant invitations.",
    "This capability records consent only. Independent tutorial qualification is unavailable, so this declaration cannot be accepted for public recognition, enroll a source, award credit or authorize publication. A later separately reviewed qualifier and actual source-use evidence are required.",
    "Changing the declaration or attribution requires a new claim revision and fresh affirmative consent. You may decline or withdraw this optional attribution. Account privacy choices still apply; retained-data deletion is a separate process and can remain pending.",
    "Withdrawal cannot delete the GitHub manifest, the external tutorial or third-party copies. No retention duration or deletion deadline is promised. Real evidence still requires approved retention settings and a responsible operator.",
  ]),
});
const terms = Object.freeze({
  ...content,
  digest: createHash("sha256").update(canonical(content)).digest("hex"),
});

export function externalTutorialTerms() {
  return structuredClone(terms);
}

export const isExternalTutorialIntake = (value) => value?.schemaVersion === externalTutorialIntakeVersion;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, names) => record(value) && Object.keys(value).sort().join("\n") === [...names].sort().join("\n");
const bounded = (value, maximum) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value === value.trim() &&
  value.length <= maximum &&
  !/[\u0000-\u001f\u007f]/.test(value);
const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}(?![\s\S])/.test(value);

/** A small detached JSON declaration; no source body, hooks or external requests. */
function copyDeclaration(value) {
  let nodes = 0;
  let characters = 0;
  const ancestors = new Set();
  const visit = (item, depth) => {
    if (++nodes > 200 || depth > 6) throw new TypeError("Invalid tutorial declaration");
    if (item === null) return null;
    if (typeof item === "string") {
      characters += item.length;
      if (item.length > 4096 || characters > 12000) throw new TypeError("Invalid tutorial declaration");
      return item;
    }
    if (!item || typeof item !== "object" || types.isProxy(item) || ancestors.has(item))
      throw new TypeError("Invalid tutorial declaration");
    ancestors.add(item);
    const names = Reflect.ownKeys(item);
    if (names.length > 64 || names.some((name) => typeof name !== "string"))
      throw new TypeError("Invalid tutorial declaration");
    let output;
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || item.length > 21 || names.length !== item.length + 1)
        throw new TypeError("Invalid tutorial declaration");
      output = [];
      for (let index = 0; index < item.length; index++) {
        const field = Object.getOwnPropertyDescriptor(item, String(index));
        if (!field?.enumerable || !Object.hasOwn(field, "value")) throw new TypeError("Invalid tutorial declaration");
        output.push(visit(field.value, depth + 1));
      }
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item)))
        throw new TypeError("Invalid tutorial declaration");
      output = Object.create(null);
      for (const name of names) {
        characters += name.length;
        const field = Object.getOwnPropertyDescriptor(item, name);
        if (name.length > 128 || characters > 12000 || !field?.enumerable || !Object.hasOwn(field, "value"))
          throw new TypeError("Invalid tutorial declaration");
        output[name] = visit(field.value, depth + 1);
      }
    }
    ancestors.delete(item);
    return output;
  };
  const copied = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(copied)) > 12000) throw new TypeError("Invalid tutorial declaration");
  return copied;
}

function canonicalUrl(value) {
  if (!bounded(value, 2048)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.href.includes("#") &&
      url.href === value
      ? url
      : null;
  } catch {
    return null;
  }
}

function manifestLocator(value) {
  const url = canonicalUrl(value);
  if (!url || url.hostname !== "github.com" || url.href.includes("?")) return false;
  const match = url.pathname.match(
    /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/blob\/(?:[a-f0-9]{40}|[a-f0-9]{64})\/(.+)(?![\s\S])/,
  );
  if (!match) return false;
  try {
    return match[1].split("/").every((part) => {
      const decoded = decodeURIComponent(part);
      return decoded !== "." && decoded !== ".." && bounded(decoded, 255) && !/[\/\\]/.test(decoded);
    });
  } catch {
    return false;
  }
}

function publicationTime(value) {
  if (value === null) return true;
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z(?![\s\S])/.test(value)) return false;
  const parsed = new Date(value);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString() === (value.length === 20 ? value.slice(0, -1) + ".000Z" : value)
  );
}

/** The authenticated request supplies the carrier and exact participant set. Pins remain declarations. */
export function parseExternalTutorialDeclaration(value, { owner, locator, category, roles, participantIds } = {}) {
  try {
    const input = copyDeclaration(value);
    if (
      !keys(input, ["schemaVersion", "canonicalUrl", "revision", "manifest", "publishedAt", "attribution"]) ||
      input.schemaVersion !== externalTutorialDeclarationVersion ||
      !canonicalUrl(input.canonicalUrl) ||
      !keys(input.revision, ["id", "contentSha256"]) ||
      !bounded(input.revision.id, 128) ||
      !hash(input.revision.contentSha256) ||
      !keys(input.manifest, ["locator", "contentSha256"]) ||
      !manifestLocator(input.manifest.locator) ||
      input.manifest.locator !== locator ||
      !hash(input.manifest.contentSha256) ||
      !publicationTime(input.publishedAt) ||
      category !== "other" ||
      typeof owner !== "string" ||
      !/^[1-9][0-9]{0,19}(?![\s\S])/.test(owner) ||
      !Array.isArray(participantIds) ||
      !Array.isArray(input.attribution) ||
      input.attribution.length !== participantIds.length + 1
    )
      return null;
    const expected = [owner, ...participantIds].sort();
    if (new Set(expected).size !== expected.length) return null;
    const attribution = input.attribution.map((entry) => {
      if (!keys(entry, ["actorId", "role"]) || !expected.includes(entry.actorId)) throw new TypeError();
      const role = entry.actorId === owner ? roles.submitter : roles.collaborators[entry.actorId];
      if (entry.role !== role) throw new TypeError();
      return { actorId: entry.actorId, role };
    });
    attribution.sort((left, right) => (left.actorId < right.actorId ? -1 : left.actorId > right.actorId ? 1 : 0));
    if (attribution.some((entry, index) => entry.actorId !== expected[index])) return null;
    return {
      schemaVersion: externalTutorialDeclarationVersion,
      canonicalUrl: input.canonicalUrl,
      revision: { id: input.revision.id, contentSha256: input.revision.contentSha256 },
      manifest: { locator: input.manifest.locator, contentSha256: input.manifest.contentSha256 },
      publishedAt: input.publishedAt,
      attribution,
    };
  } catch {
    return null;
  }
}

CREATE TABLE projects (
  id text PRIMARY KEY,
  name text NOT NULL,
  repository_url text NOT NULL,
  is_synthetic boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE actors (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  is_synthetic boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE source_observations (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  actor_id text NOT NULL REFERENCES actors(id),
  action text NOT NULL,
  subject text NOT NULL,
  occurred_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  source_url text NOT NULL,
  is_synthetic boolean NOT NULL DEFAULT false,
  UNIQUE (project_id, source_url)
);

CREATE INDEX source_observations_actor_time_idx
  ON source_observations (actor_id, occurred_at DESC);

-- Historical rows remain explicitly unobserved; no discovery/update timestamp is substituted.
ALTER TABLE public.publications ADD COLUMN first_public_at timestamptz;
ALTER TABLE public.publications ADD COLUMN first_publication_observed boolean NOT NULL DEFAULT false;
ALTER TABLE public.publications ADD CONSTRAINT first_public_time_requires_observation
  CHECK (first_public_at IS NULL OR first_publication_observed);

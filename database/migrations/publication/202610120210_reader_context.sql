ALTER TABLE public.publications ADD COLUMN company_context jsonb NOT NULL DEFAULT '[]'::jsonb;

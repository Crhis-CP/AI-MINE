-- Rule-built issues are recorded separately from paid prose. Historical origins remain unchanged.
ALTER TABLE public.reports DROP CONSTRAINT reports_origin_check;
ALTER TABLE public.reports ADD CONSTRAINT reports_origin_check CHECK (origin IN ('model', 'imported', 'manual', 'rule'));

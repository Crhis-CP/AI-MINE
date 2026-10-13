-- Accept verified project themes when the industry dictionary supplies them.
ALTER TABLE public.topics DROP CONSTRAINT topics_grp_check;
ALTER TABLE public.topics ADD CONSTRAINT topics_grp_check CHECK (grp IN ('company', 'field', 'genre', 'project'));

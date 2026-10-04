INSERT INTO sources (id, name, kind, config) VALUES ('role-source', 'Role fixture', 'rss', '{}');
INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, language, body_text, raw)
VALUES ('role-public', 'role-source', 'role-public', 'https://fixture.invalid/public', 'Public', now(), now(), 'zh', 'public-body', '{"private":true}'),
       ('role-candidate', 'role-source', 'role-candidate', 'https://fixture.invalid/candidate', 'Candidate', now(), now(), 'zh', 'candidate-body', '{"private":true}');
INSERT INTO translations (article_id, lang, revision, body_html) VALUES ('role-public', 'zh', 1, '<p>public translation</p>'), ('role-candidate', 'zh', 1, '<p>candidate translation</p>');
INSERT INTO publications (article_id, title, source_id, channel, url, discovered_at, timeline_at, sort_at, visibility)
VALUES ('role-public', 'Public', 'role-source', 'news', 'https://fixture.invalid/public', now(), now(), now(), 'summary-only');
INSERT INTO settings (key, value) VALUES ('private.fixture', '{"private":true}');
INSERT INTO feedback_bans (source_hash) VALUES ('fixture-ban');

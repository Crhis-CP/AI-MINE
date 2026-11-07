-- First-party visit statistics (TASK-0571; Owner 2026-11-06/07): daily and monthly visitors and page views of the
-- reader pages, for the private admin. No cookie and no third-party service. A visitor is an anonymous key: an HMAC
-- of the client address and browser string under a random salt that changes each Beijing day (daily visitors) or
-- month (monthly visitors). The raw address and browser string are never stored. A salt is deleted once its day or
-- month is over; a key set is deleted once its period is counted (a day's on the day after next, a month's on the
-- 2nd of the month after); only the counts below stay.
CREATE TABLE ops.visit_salts (
  period text NOT NULL CHECK (period IN ('day','month')),
  starts_on date NOT NULL,
  salt bytea NOT NULL CHECK (length(salt)=32),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (period, starts_on),
  CHECK (period='day' OR extract(day FROM starts_on)=1)
);
CREATE TABLE ops.visit_day_keys (
  day date NOT NULL,
  visitor text NOT NULL CHECK (visitor ~ '^[A-Za-z0-9_-]{22}$'),
  device text NOT NULL CHECK (device IN ('phone','tablet','desktop')),
  PRIMARY KEY (day, visitor)
);
CREATE TABLE ops.visit_month_keys (
  month date NOT NULL CHECK (extract(day FROM month)=1),
  visitor text NOT NULL CHECK (visitor ~ '^[A-Za-z0-9_-]{22}$'),
  PRIMARY KEY (month, visitor)
);
-- Per Beijing day. visitors stays NULL until the day's keys are first counted.
CREATE TABLE ops.visit_days (
  day date PRIMARY KEY,
  page_views integer NOT NULL DEFAULT 0 CHECK (page_views >= 0),
  english_views integer NOT NULL DEFAULT 0 CHECK (english_views >= 0),
  visitors integer CHECK (visitors >= 0),
  counted_at timestamptz
);
-- route is the page's route pattern (/items/:id); path keeps a content page's own address (/items/abc), never a query.
CREATE TABLE ops.visit_pages (
  day date NOT NULL,
  path text NOT NULL CHECK (path LIKE '/%' AND length(path) <= 200),
  route text NOT NULL CHECK (route LIKE '/%' AND length(route) <= 80),
  views integer NOT NULL CHECK (views >= 0),
  PRIMARY KEY (day, path)
);
-- Host of the page a visit came from (other sites only).
CREATE TABLE ops.visit_referrers (
  day date NOT NULL,
  host text NOT NULL CHECK (length(host) BETWEEN 1 AND 253),
  views integer NOT NULL CHECK (views >= 0),
  PRIMARY KEY (day, host)
);
CREATE TABLE ops.visit_devices (
  day date NOT NULL,
  device text NOT NULL CHECK (device IN ('phone','tablet','desktop')),
  views integer NOT NULL DEFAULT 0 CHECK (views >= 0),
  visitors integer CHECK (visitors >= 0),
  PRIMARY KEY (day, device)
);
CREATE TABLE ops.visit_months (
  month date PRIMARY KEY CHECK (extract(day FROM month)=1),
  visitors integer NOT NULL CHECK (visitors >= 0),
  counted_at timestamptz NOT NULL
);

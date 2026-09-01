#!/usr/bin/env node
// Generates assets/stats.svg from the GitHub API.
// No third-party service — this runs in your own repo via .github/workflows/stats.yml
// Every field degrades to an em-dash rather than failing, so the card always renders.

import { writeFileSync, mkdirSync } from 'node:fs';

const USER = process.env.STATS_USER || 'EdNoX04';
const TOKEN = process.env.GITHUB_TOKEN || '';
const YEAR = new Date().getUTCFullYear();

const FONT =
  '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, "Helvetica Neue", Helvetica, Arial, sans-serif';

const headers = {
  'User-Agent': 'profile-stats',
  Accept: 'application/vnd.github+json',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

const num = (n) => (n === null || n === undefined ? '—' : n.toLocaleString('en-US'));

async function rest(path) {
  const r = await fetch(`https://api.github.com${path}`, { headers });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

async function graphql(query, variables) {
  const r = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) throw new Error(`graphql → ${r.status}`);
  const j = await r.json();
  if (j.errors?.length) throw new Error(j.errors.map((e) => e.message).join('; '));
  return j.data;
}

const stats = {
  stars: null, commits: null, prs: null, issues: null,
  hours: null, streak: null, week: null, repos: null, activePct: null,
};

// ── stars + public repo count ────────────────────────────────────────────────
try {
  const u = await rest(`/users/${USER}`);
  stats.repos = u.public_repos;
} catch (e) { console.error('user:', e.message); }

try {
  let stars = 0;
  for (let page = 1; page <= 10; page++) {
    const repos = await rest(`/users/${USER}/repos?per_page=100&type=owner&page=${page}`);
    stars += repos.reduce((a, r) => a + (r.fork ? 0 : r.stargazers_count), 0);
    if (repos.length < 100) break;
  }
  stats.stars = stars;
} catch (e) { console.error('repos:', e.message); }

// ── contributions: commits, PRs, issues, streak, this week, active days ──────
try {
  const data = await graphql(
    `query($login:String!, $from:DateTime!) {
       user(login:$login) {
         contributionsCollection(from:$from) {
           totalCommitContributions
           restrictedContributionsCount
           totalPullRequestContributions
           totalIssueContributions
           contributionCalendar {
             weeks { contributionDays { date contributionCount } }
           }
         }
       }
     }`,
    { login: USER, from: `${YEAR}-01-01T00:00:00Z` }
  );
  const c = data.user.contributionsCollection;
  stats.commits = c.totalCommitContributions + c.restrictedContributionsCount;
  stats.prs = c.totalPullRequestContributions;
  stats.issues = c.totalIssueContributions;

  const today = new Date().toISOString().slice(0, 10);
  const days = c.contributionCalendar.weeks
    .flatMap((w) => w.contributionDays)
    .filter((d) => d.date <= today)
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const active = days.filter((d) => d.contributionCount > 0).length;
  stats.activePct = days.length ? Math.round((active / days.length) * 100) : null;

  // last 7 calendar days including today
  stats.week = days.slice(-7).reduce((a, d) => a + d.contributionCount, 0);

  // current streak: walk backwards; today counting as 0 does not break it yet
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].contributionCount > 0) streak++;
    else if (i === days.length - 1) continue;   // today still has time left
    else break;
  }
  stats.streak = streak;
} catch (e) { console.error('contributions:', e.message); }

// ── estimated coding hours, from real commit timestamps ──────────────────────
// Sessions are inferred the way git-hours does it: consecutive commits less than
// MAX_GAP apart count as one continuous stretch; a commit that starts a session
// is credited FIRST_COMMIT_ADD. Public repos only — a read:user token cannot see
// private commit history, so this under-counts if you work in private repos.
const MAX_GAP_MS = 2 * 60 * 60 * 1000;
const FIRST_COMMIT_MS = 30 * 60 * 1000;

try {
  const me = await graphql(`query($login:String!){ user(login:$login){ id } }`, { login: USER });
  const authorId = me.user.id;
  const since = `${YEAR}-01-01T00:00:00Z`;

  const repoData = await graphql(
    `query($login:String!) {
       user(login:$login) {
         repositories(first:100, ownerAffiliations:[OWNER], isFork:false) {
           nodes { name }
         }
       }
     }`,
    { login: USER }
  );

  const times = [];
  for (const repo of repoData.user.repositories.nodes) {
    let cursor = null;
    for (let page = 0; page < 5; page++) {
      const d = await graphql(
        `query($login:String!, $name:String!, $since:GitTimestamp!, $author:ID!, $cursor:String) {
           repository(owner:$login, name:$name) {
             defaultBranchRef {
               target {
                 ... on Commit {
                   history(since:$since, author:{id:$author}, first:100, after:$cursor) {
                     nodes { committedDate }
                     pageInfo { hasNextPage endCursor }
                   }
                 }
               }
             }
           }
         }`,
        { login: USER, name: repo.name, since, author: authorId, cursor }
      ).catch(() => null);

      const h = d?.repository?.defaultBranchRef?.target?.history;
      if (!h) break;
      for (const n of h.nodes) times.push(new Date(n.committedDate).getTime());
      if (!h.pageInfo.hasNextPage) break;
      cursor = h.pageInfo.endCursor;
    }
  }

  if (times.length) {
    times.sort((a, b) => a - b);
    let ms = 0;
    for (let i = 0; i < times.length; i++) {
      const gap = i === 0 ? Infinity : times[i] - times[i - 1];
      ms += gap < MAX_GAP_MS ? gap : FIRST_COMMIT_MS;
    }
    stats.hours = Math.round(ms / 3600000 * 10) / 10;
  }
} catch (e) { console.error('coding hours:', e.message); }

// ── icons (16px, stroked) ────────────────────────────────────────────────────
const ICON = {
  star: 'M8 1.6l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.4l-3.8 2 .7-4.3-3.1-3 4.3-.6z',
  commit: 'M1 8h3.6M11.4 8H15',
  pr: 'M4 5.5v7M12 3.5v3.2a2 2 0 0 1-2 2H6',
  issue: 'M8 8h.01',
  clock: 'M8 4.2V8l2.4 1.6',
  flame: 'M8 14.4c2.3 0 4-1.5 4-3.7 0-2.4-1.7-3.5-2.6-5.5-.4-.9-.5-1.8-.4-2.6-1.6.7-2.7 2-3.2 3.3-.4 1-.3 2-.1 2.7-.7-.2-1.1-.9-1.3-1.6-.6.8-.9 1.9-.9 2.9 0 2.5 1.9 4.5 4.5 4.5z',
  week: 'M3 6.2h10M5.6 2.4v2.4M10.4 2.4v2.4',
};

const extra = {
  commit: '<circle cx="8" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  pr: '<circle cx="4" cy="3.6" r="1.9" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="4" cy="12.4" r="1.9" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="9.4" r="1.9" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  issue: '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  clock: '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  week: '<rect x="2" y="3.4" width="12" height="10.6" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.5"/>',
};

const days = (n) => (n === null ? '—' : n === 1 ? '1 day' : `${n} days`);
const hrs = (n) => (n === null ? '—' : `${n.toLocaleString('en-US')}h`);

const rows = [
  ['star',   'Total Stars Earned',     num(stats.stars),  '#34d399'],
  ['commit', `Total Commits (${YEAR})`, num(stats.commits), '#2dd4bf'],
  ['pr',     'Pull Requests',          num(stats.prs),    '#22d3ee'],
  ['issue',  'Issues Opened',          num(stats.issues), '#38bdf8'],
  ['clock',  'Estimated Coding Hours', hrs(stats.hours),  '#5eead4'],
  ['flame',  'Current Streak',         days(stats.streak), '#34d399'],
  ['week',   'Commits This Week',      num(stats.week),   '#2dd4bf'],
];

// ── render ───────────────────────────────────────────────────────────────────
const R = 66;
const CIRC = 2 * Math.PI * R;
const pct = stats.activePct ?? 0;
const dash = (CIRC * pct) / 100;

let body = '';
rows.forEach(([icon, label, value, col], i) => {
  const y = 104 + i * 31;
  const delay = (0.1 + i * 0.06).toFixed(2);
  body += `    <g class="an" style="animation-delay:${delay}s">
      <g transform="translate(48 ${y - 12})" stroke="${col}" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.85">${extra[icon] || ''}<path d="${ICON[icon]}"${icon === 'star' ? ` fill="${col}" fill-opacity="0.18"` : ''}/></g>
      <text class="f lb" x="80" y="${y}">${label}</text>
      <text class="f vl" x="800" y="${y}" text-anchor="end" fill="${col}">${value}</text>
    </g>\n`;
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 340" width="1200" height="340" role="img" aria-label="GitHub statistics for ${USER}">
  <title>GitHub statistics</title>
  <defs>
    <linearGradient id="s-card" x1="0" y1="0" x2="0.5" y2="1">
      <stop offset="0%" stop-color="#101d1a"/>
      <stop offset="100%" stop-color="#0a1014"/>
    </linearGradient>
    <linearGradient id="s-ring" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#22d3ee"/>
      <stop offset="100%" stop-color="#34d399"/>
    </linearGradient>
  </defs>
  <style>
    .f { font-family: ${FONT}; }
    .hd { font-size: 13px; font-weight: 600; letter-spacing: 3px; fill: #5eead4; }
    .lb { font-size: 16px; font-weight: 400; fill: #9fbdb5; }
    .vl { font-size: 16px; font-weight: 600; }
    .rp { font-size: 34px; font-weight: 700; fill: #eafff8; }
    .rl { font-size: 11px; font-weight: 600; letter-spacing: 2.2px; fill: #4d6f67; }
    .an { opacity: 0; animation: rise .8s cubic-bezier(.16,1,.3,1) forwards; }
    @keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
    .arc { stroke-dasharray: ${dash.toFixed(1)} ${CIRC.toFixed(1)}; animation: draw 1.3s cubic-bezier(.16,1,.3,1) .3s backwards; }
    @keyframes draw { from { stroke-dasharray: 0 ${CIRC.toFixed(1)}; } }
    @media (prefers-reduced-motion: reduce) { .an { animation: none; opacity: 1; } .arc { animation: none; } }
  </style>

  <rect x="1" y="1" width="1198" height="338" rx="20" fill="url(#s-card)" stroke="#1c3b35" stroke-width="1"/>
  <text class="f hd" x="48" y="56">STATS</text>

${body}
  <g transform="translate(1012 197)">
    <circle r="${R}" fill="none" stroke="#1c3b35" stroke-width="9"/>
    <circle class="arc" r="${R}" fill="none" stroke="url(#s-ring)" stroke-width="9"
            stroke-linecap="round" transform="rotate(-90)"/>
    <text class="f rp" y="6" text-anchor="middle">${stats.activePct === null ? '—' : pct + '%'}</text>
    <text class="f rl" y="30" text-anchor="middle">ACTIVE DAYS</text>
  </g>
</svg>
`;

mkdirSync('assets', { recursive: true });
writeFileSync('assets/stats.svg', svg);
console.log('wrote assets/stats.svg', JSON.stringify(stats));

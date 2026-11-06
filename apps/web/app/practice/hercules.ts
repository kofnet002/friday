// Practice 2: a technical customer support assessment in the style of an AI
// app-builder company (customers describe an app, an agent builds it; support
// engineers fix what the agent got wrong). Shaped by Hercules' public job post:
// TypeScript/React, HTTP/APIs/auth/databases, production debugging, incident
// comms and high ticket volume. The scenarios, code, data and people are
// invented for practice.

import { PAGE_CASES, SPIKE_CASES, TRIAGE_CASES } from './hercules-cases';
import type { ChoiceQuestion, CodingQuestion, PracticeTest, WrittenQuestion } from './types';

const triage: CodingQuestion = {
  id: 'h1',
  kind: 'coding',
  title: 'SLA Queue Triage',
  difficulty: 'Easy',
  points: 15,
  blocks: [
    {
      t: 'p',
      text: 'You start your shift with a queue of support tickets. Each ticket is `[id, priority, created, status]`, where `created` is the minute the ticket was opened and `status` is `"open"`, `"pending"` (waiting on the customer) or `"solved"`.',
    },
    {
      t: 'p',
      text: "Each priority has a first-response SLA. A ticket's **time left** is `created + SLA - now`; it is negative once the SLA is breached.",
    },
    {
      t: 'table',
      head: ['Priority', 'SLA (minutes)'],
      rows: [
        ['P1', '60'],
        ['P2', '240'],
        ['P3', '1440'],
        ['P4', '4320'],
      ],
    },
    {
      t: 'p',
      text: 'Return the ticket ids in the order you should work them:',
    },
    {
      t: 'list',
      ordered: true,
      items: [
        'Leave out solved tickets.',
        'All open tickets come before all pending tickets.',
        'Within each group, least time left first.',
        'Ties on time left: higher priority first (`P1` before `P2`), then by id in ascending string order.',
      ],
    },
    {
      t: 'example',
      input:
        'tickets = [["T-104","P2",900,"open"],["T-101","P1",1000,"open"],["T-099","P3",0,"solved"],["T-102","P4",50,"pending"],["T-103","P1",960,"open"]], now = 1030',
      output: '["T-103","T-101","T-104","T-102"]',
      explanation:
        'Time left: T-103 is -10 (breached), T-101 is 30, T-104 is 110. T-102 is pending, so it goes last. T-099 is solved.',
    },
    {
      t: 'example',
      input: 'tickets = [["A","P3",0,"open"],["B","P2",1200,"open"]], now = 1440',
      output: '["B","A"]',
      explanation: 'Both have 0 minutes left; P2 beats P3.',
    },
    {
      t: 'example',
      input:
        'tickets = [["Z-2","P1",500,"pending"],["Z-1","P1",500,"pending"],["Z-3","P2",320,"open"]], now = 600',
      output: '["Z-3","Z-1","Z-2"]',
    },
    { t: 'h', text: 'Constraints' },
    {
      t: 'list',
      items: [
        '`0 <= tickets.length <= 10^4`',
        '`0 <= created, now <= 10^6`',
        'Ticket ids are unique ASCII strings.',
      ],
    },
  ],
  fn: { python: 'triage_queue', javascript: 'triageQueue' },
  params: ['tickets', 'now'],
  starter: {
    python: `from typing import List


def triage_queue(tickets: List[list], now: int) -> List[str]:
    # Write your code here
    pass
`,
    javascript: `/**
 * @param {Array<[string, string, number, string]>} tickets
 * @param {number} now
 * @return {string[]}
 */
function triageQueue(tickets, now) {
  // Write your code here
}
`,
  },
  tests: TRIAGE_CASES,
};

const pagination: CodingQuestion = {
  id: 'h2',
  kind: 'coding',
  title: 'Fix: Orders Page Pagination',
  difficulty: 'Medium',
  points: 20,
  blocks: [
    { t: 'h', text: 'Ticket #48213 · Bloom & Basket (bakery) · Priority P2' },
    {
      t: 'note',
      text: '"The Orders page in our admin app is wrong. When I click Next, the last order from the page before shows up again, and on busy mornings some orders never show on any page. Orders we deleted also keep showing. We do our deliveries from this page, please help!" — Dana, owner',
    },
    {
      t: 'p',
      text: 'The app agent generated `fetch_page` for the Orders page. The editor contains its code **exactly as shipped**. Fix it.',
    },
    { t: 'h', text: 'How the page works' },
    {
      t: 'list',
      items: [
        'Each order is `[id, created_at, deleted]`. `id` is unique. Many orders can share the same `created_at` (orders imported in a batch get the same timestamp).',
        'Orders are listed **newest first**: by `created_at` descending, then by `id` descending.',
        'Deleted orders (`deleted` is true) are never shown and do not count toward `limit`.',
        'The first page is requested with `cursor = null`. Each next page is requested with the cursor `[created_at, id]` of the **last order on the previous page**.',
        "The cursor's order may have been deleted since the previous page loaded. The next page still starts right after its position.",
        'Return the ids of at most `limit` orders that come strictly after the cursor in the list order.',
      ],
    },
    {
      t: 'p',
      text: 'Walking every page from `null` must return each visible order exactly once, with nothing skipped or repeated.',
    },
    {
      t: 'example',
      input:
        'orders = [[501,1700,false],[502,1700,false],[499,1650,true],[503,1700,false],[498,1600,false],[497,1650,false],[496,1500,false]], cursor = null, limit = 3',
      output: '[503,502,501]',
    },
    {
      t: 'example',
      input: 'same orders, cursor = [1700,502], limit = 3',
      output: '[501,497,498]',
      explanation:
        'After 502 comes 501 (same timestamp, smaller id), then 497. Order 499 is deleted, so it is skipped.',
    },
    {
      t: 'example',
      input: 'same orders, cursor = [1650,497], limit = 3',
      output: '[498,496]',
    },
    { t: 'h', text: 'Constraints' },
    {
      t: 'list',
      items: [
        '`0 <= orders.length <= 10^4`',
        '`1 <= limit <= 100`',
        '`cursor` is `null` or `[created_at, id]`',
      ],
    },
    {
      t: 'note',
      text: 'In the follow-up call you will be asked what each bug was and how you would stop the agent from generating it again.',
    },
  ],
  fn: { python: 'fetch_page', javascript: 'fetchPage' },
  params: ['orders', 'cursor', 'limit'],
  starter: {
    python: `from typing import List, Optional


def fetch_page(orders: List[list], cursor: Optional[List[int]], limit: int) -> List[int]:
    # Orders page: newest first, keyset pagination.
    rows = sorted(orders, key=lambda o: o[1], reverse=True)
    if cursor is not None:
        created_at, last_id = cursor
        rows = [o for o in rows if o[1] <= created_at]
    return [o[0] for o in rows[:limit]]
`,
    javascript: `/**
 * Orders page: newest first, keyset pagination.
 * @param {Array<[number, number, boolean]>} orders
 * @param {[number, number] | null} cursor
 * @param {number} limit
 * @return {number[]}
 */
function fetchPage(orders, cursor, limit) {
  let rows = [...orders].sort((a, b) => b[1] - a[1]);
  if (cursor !== null) {
    const [createdAt, lastId] = cursor;
    rows = rows.filter((o) => o[1] <= createdAt);
  }
  return rows.slice(0, limit).map((o) => o[0]);
}
`,
  },
  tests: PAGE_CASES,
};

const spikes: CodingQuestion = {
  id: 'h3',
  kind: 'coding',
  title: '5xx Spike Alerts',
  difficulty: 'Medium',
  points: 25,
  blocks: [
    {
      t: 'p',
      text: 'Customer apps write one access-log line per request. Support wants an alert whenever one app starts failing, so a human can look **before** the customer writes in.',
    },
    {
      t: 'p',
      text: 'A valid line has exactly four whitespace-separated fields: `timestamp app_id status path`. `timestamp` is a non-negative integer (seconds), `status` is exactly three digits. Skip every other line: the log shipper sometimes writes junk.',
    },
    {
      t: 'p',
      text: 'Only server errors count: `500 <= status <= 599`. Lines can arrive out of order; process the server errors sorted by timestamp, and for equal timestamps in the order the lines appear in `logs`.',
    },
    { t: 'h', text: 'Alert rules, per app' },
    {
      t: 'list',
      ordered: true,
      items: [
        'When an app has a server error at time `t`, count its server errors in the window `(t - window, t]` (including this one).',
        'If the app is not already in an incident and the count reaches `threshold`, emit `[app_id, t]` and the app is now in an incident.',
        "An incident ends at the app's next server error that has **no** other server error from that app in its window. That error is counted normally, so it can open a new incident if `threshold` is 1.",
      ],
    },
    {
      t: 'p',
      text: 'Return all alerts in the order they were emitted.',
    },
    {
      t: 'example',
      input:
        'logs = ["100 app_7 500 /api/orders", "101 app_7 200 /api/orders", "103 app_7 502 /api/login", "104 app_2 500 /api/orders", "107 app_7 503 /api/orders", "130 app_7 500 /api/orders"], window = 10, threshold = 3',
      output: '[["app_7",107]]',
      explanation:
        'At 107, app_7 has errors at 100, 103 and 107 in (97, 107]. At 130 the window (120, 130] holds no earlier error, so the incident ends; one error is not enough to alert again.',
    },
    {
      t: 'example',
      input:
        'logs = ["5 app_a 500 /x", "3 app_a 500 /x", "garbage line", "4 app_a 429 /x", "6 app_a 504 /x", "20 app_a 500 /x", "21 app_a 500 /x", "22 app_a 500 /x"], window = 5, threshold = 2',
      output: '[["app_a",5],["app_a",21]]',
      explanation:
        '429 is not a server error. Sorted errors: 3, 5, 6, 20, 21, 22. The alert at 5 covers 6 too. At 20 the window (15, 20] is otherwise empty, so the incident ends, and 21 alerts again.',
    },
    {
      t: 'example',
      input:
        'logs = ["10 app_x 500 /a", "10 app_y 500 /a", "11 app_y 500 /a", "11 app_x 500 /a", "12 app_x 499 /a", "12 app_x 600 /a"], window = 3, threshold = 2',
      output: '[["app_y",11],["app_x",11]]',
      explanation: "Both alert at 11; app_y's line comes first in the log.",
    },
    { t: 'h', text: 'Constraints' },
    {
      t: 'list',
      items: ['`0 <= logs.length <= 10^5`', '`1 <= window <= 3600`', '`1 <= threshold <= 1000`'],
    },
  ],
  fn: { python: 'spike_alerts', javascript: 'spikeAlerts' },
  params: ['logs', 'window', 'threshold'],
  starter: {
    python: `from typing import List


def spike_alerts(logs: List[str], window: int, threshold: int) -> List[list]:
    # Write your code here
    pass
`,
    javascript: `/**
 * @param {string[]} logs
 * @param {number} window
 * @param {number} threshold
 * @return {Array<[string, number]>}
 */
function spikeAlerts(logs, window, threshold) {
  // Write your code here
}
`,
  },
  tests: SPIKE_CASES,
};

const fundamentals: ChoiceQuestion = {
  id: 'h4',
  kind: 'choice',
  title: 'Web Fundamentals',
  points: 15,
  blocks: [
    {
      t: 'p',
      text: 'Six short scenarios from real-looking tickets. Pick the best answer for each.',
    },
  ],
  items: [
    {
      id: 'h4a',
      prompt:
        "A customer's app at https://app.bloombasket.com calls its API at https://api.bloombasket.com. The browser console shows the error below. Where does the fix belong?",
      code: "Access to fetch at 'https://api.bloombasket.com/orders' from origin 'https://app.bloombasket.com' has been blocked by CORS policy: Response to preflight request doesn't pass access control check: No 'Access-Control-Allow-Origin' header is present on the requested resource.",
      options: [
        "In the frontend: add mode: 'no-cors' to the fetch call",
        'In the API: answer the OPTIONS preflight with Access-Control-Allow-Origin (and the allowed methods/headers) for that origin',
        'In DNS: point both subdomains at the same IP address',
        'In the browser: the customer should clear cookies and retry',
      ],
      answer: 1,
    },
    {
      id: 'h4b',
      prompt:
        'A signed-in staff member with a valid session opens the Admin → Payouts page. The user is not an admin. What should the API return?',
      options: [
        '200 with an empty list',
        '401 Unauthorized',
        '403 Forbidden',
        '404 Not Found, always',
      ],
      answer: 2,
    },
    {
      id: 'h4c',
      prompt: 'Network tab shows /api/profile being requested hundreds of times a second. Why?',
      code: `const [profile, setProfile] = useState(null);
useEffect(() => {
  fetch('/api/profile').then((r) => r.json()).then(setProfile);
}, [profile]);`,
      options: [
        'React StrictMode always does this in production',
        'Each response creates a new object, which changes profile, which re-runs the effect',
        'fetch retries automatically when the response is slow',
        'useState(null) makes the component mount repeatedly',
      ],
      answer: 1,
    },
    {
      id: 'h4d',
      prompt:
        'Login is slow on a Postgres table with 4 million users. The table has a B-tree index on email. The query is below. What is the best fix?',
      code: 'SELECT * FROM users WHERE lower(email) = lower($1);',
      options: [
        'Add an index on lower(email), or store emails lowercased and query email = $1',
        'Add LIMIT 1 to the query',
        'Run VACUUM FULL every night',
        'Switch the column type from text to varchar(255)',
      ],
      answer: 0,
    },
    {
      id: 'h4e',
      prompt:
        'A payment provider sometimes delivers the same "payment succeeded" webhook twice, and a customer\'s app sent two receipt emails. What is the right fix in the app?',
      options: [
        'Respond with 500 to duplicate deliveries so they stop',
        'Process webhooks in a setTimeout so the second one arrives first',
        'Record each event id when it is handled, and skip events already recorded',
        'Turn off webhook retries in the provider dashboard',
      ],
      answer: 2,
    },
    {
      id: 'h4f',
      prompt:
        "An app's frontend on https://shop.example.com calls an API on https://example-api.com with credentials: 'include'. Login succeeds, but the session cookie is never sent on the next request. Most likely cause?",
      options: [
        'The cookie needs SameSite=None; Secure to be sent on cross-site requests',
        'Cookies are limited to 4 KB and the session is too large',
        'The API must use HTTP/2',
        'The cookie needs HttpOnly removed',
      ],
      answer: 0,
    },
  ],
};

const bookingsLeak: WrittenQuestion = {
  id: 'h5',
  kind: 'written',
  title: "Customers See Each Other's Bookings",
  points: 15,
  blocks: [
    { t: 'h', text: 'Ticket #48377 · Lumen Physio · Priority P1' },
    {
      t: 'note',
      text: '"Two of our patients emailed us that the My Bookings page showed OTHER people\'s appointments, with names and times. This is a big privacy problem for a clinic. Also, sometimes the page goes completely white for patients who left it open for a while." — Marcus Hale, practice manager',
    },
    {
      t: 'p',
      text: "The clinic's app was generated by the app agent. Each signed-in session has `session.userId` and `session.businessId`. Here are the API route and the page component:",
    },
    {
      t: 'code',
      text: `1   // server/routes/bookings.ts  (Hono + Drizzle)
2   app.get('/api/bookings', async (c) => {
3     const session = await getSession(c);
4     if (!session) return c.json({ error: 'unauthorized' }, 401);
5     const businessId = c.req.query('businessId');
6     const rows = await db
7       .select()
8       .from(bookings)
9       .where(eq(bookings.businessId, businessId))
10      .orderBy(desc(bookings.startsAt));
11    return c.json(rows);
12  });
13
14  // app/components/MyBookings.tsx
15  export function MyBookings({ businessId }: { businessId: string }) {
16    const [rows, setRows] = useState<Booking[]>([]);
17    useEffect(() => {
18      fetch(\`/api/bookings?businessId=\${businessId}\`)
19        .then((r) => r.json())
20        .then(setRows);
21    }, []);
22    return rows.map((b, i) => <BookingRow key={i} booking={b} />);
23  }`,
    },
    { t: 'h', text: "From the app's logs" },
    {
      t: 'table',
      head: ['Time (UTC)', 'Event'],
      rows: [
        ['09:12:04', 'GET /api/bookings?businessId=biz_lumen 200 · user u_381 · 214 rows'],
        ['09:12:31', 'GET /api/bookings?businessId=biz_northgym 200 · user u_381 · 1,902 rows'],
        ['11:47:55', 'GET /api/bookings?businessId=biz_lumen 401 · session expired'],
        ['11:47:55', 'client error: TypeError: rows.map is not a function (MyBookings.tsx:22)'],
        ['11:50:02', 'deploy: theme colors updated (no code changes)'],
      ],
    },
    {
      t: 'p',
      text: 'Answer each part. Line numbers refer to the code above.',
    },
  ],
  parts: [
    {
      id: 'h5-cause',
      label: '1 · What is wrong? List each bug with its line numbers',
      maxWords: 200,
    },
    { id: 'h5-fix', label: '2 · The fixed code (route and component)', maxWords: 250 },
    { id: 'h5-reply', label: '3 · Reply to Marcus', maxWords: 150 },
    {
      id: 'h5-agent',
      label: '4 · How would you stop the agent from generating this again?',
      maxWords: 80,
    },
  ],
};

const incident: WrittenQuestion = {
  id: 'h6',
  kind: 'written',
  title: 'Incident: Custom Domains Down',
  points: 10,
  blocks: [
    {
      t: 'p',
      text: 'You are first contact for platform incidents this shift. It is 14:20 UTC.',
    },
    {
      t: 'table',
      head: ['Time (UTC)', 'Signal'],
      rows: [
        ['13:58', 'Edge deploy v412 rolled out (TLS certificate renewal job changes)'],
        ['14:03', '5xx on custom domains: 0.2% → 31%. Default *.apps subdomains: normal'],
        ['14:05', '17 tickets: "my site shows a certificate error"'],
        [
          '14:11',
          'On-call engineer (Priya): "rolling back v412, ETA 15-20 min. Certs issued after 13:58 may need re-issuing by hand."',
        ],
        ['14:16', 'Rollback 40% complete'],
      ],
    },
    {
      t: 'p',
      text: 'Write both parts. Customers read the status page; the next support shift starts at 15:00.',
    },
  ],
  parts: [
    { id: 'h6-status', label: '1 · Status page update', maxWords: 80 },
    { id: 'h6-handoff', label: '2 · Handoff note for the 15:00 shift', maxWords: 120 },
  ],
};

export const HERCULES: PracticeTest = {
  id: 'hercules',
  storageKey: 'kestrel.practice.hercules.v1',
  info: {
    platform: 'Kestrel Assess',
    company: 'Hercules',
    name: 'Technical Customer Support Engineer — Practice 2',
    minutes: 90,
  },
  questions: [triage, pagination, spikes, fundamentals, bookingsLeak, incident],
};

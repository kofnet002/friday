// Content of the practice assessment. Everything here is original: a
// fictional assessment platform ("Kestrel Assess") running a fictional
// company's test. Written to exercise Friday: long statements that need a
// scroll scan, digit-dense examples, a multiple-choice screen, and a written
// escalation exercise with code, logs and word limits.

import { BOOKING_CASES, GATEWAY_CASES, PLOW_CASES } from './test-cases';
import type { ChoiceQuestion, CodingQuestion, PracticeTest, WrittenQuestion } from './types';

const bookings: CodingQuestion = {
  id: 'q1',
  kind: 'coding',
  title: 'Merge Booking Windows',
  difficulty: 'Easy',
  points: 15,
  blocks: [
    {
      t: 'p',
      text: 'A meeting-room service stores bookings as `[start, end)` pairs in minutes since midnight. Cleaners need at least `buffer` minutes between two bookings; when the gap is smaller, the two bookings are treated as one continuous block.',
    },
    {
      t: 'p',
      text: 'Given an unsorted list of bookings and the `buffer`, return the merged blocks sorted by start time. Two bookings merge when they overlap or when `next.start - current.end < buffer`. A merged block ends at the latest end among its bookings.',
    },
    {
      t: 'example',
      input: 'bookings = [[30,60],[0,30],[90,120],[65,80]], buffer = 10',
      output: '[[0,80],[90,120]]',
      explanation:
        '[0,30] and [30,60] touch (gap 0 < 10); [65,80] starts 5 minutes after 60, so it joins too. [90,120] starts exactly 10 minutes after 80, which is enough.',
    },
    {
      t: 'example',
      input: 'bookings = [[5,10],[1,3]], buffer = 0',
      output: '[[1,3],[5,10]]',
    },
    {
      t: 'example',
      input: 'bookings = [[1,10],[2,4],[12,15]], buffer = 2',
      output: '[[1,10],[12,15]]',
      explanation:
        '[2,4] lies inside [1,10]. The gap before [12,15] is exactly 2, so it stays separate.',
    },
    { t: 'h', text: 'Constraints' },
    {
      t: 'list',
      items: [
        '`0 <= bookings.length <= 10^4`',
        '`0 <= start < end <= 1440`',
        '`0 <= buffer <= 120`',
      ],
    },
  ],
  fn: { python: 'merge_bookings', javascript: 'mergeBookings' },
  params: ['bookings', 'buffer'],
  starter: {
    python: `from typing import List


def merge_bookings(bookings: List[List[int]], buffer: int) -> List[List[int]]:
    # Write your code here
    pass
`,
    javascript: `/**
 * @param {number[][]} bookings
 * @param {number} buffer
 * @return {number[][]}
 */
function mergeBookings(bookings, buffer) {
  // Write your code here
}
`,
  },
  tests: BOOKING_CASES,
};

const gateway: CodingQuestion = {
  id: 'q2',
  kind: 'coding',
  title: 'Rate-Limited Payments Gateway',
  difficulty: 'Medium',
  points: 25,
  blocks: [
    {
      t: 'p',
      text: "Northwind Ledger's payments gateway sits in front of a card processor that bills per request. Every request carries a cost in processor credits, and the gateway must reject requests that would push spending over two limits. You are given the gateway's request log and must return which requests it rejected.",
    },
    {
      t: 'p',
      text: 'Each request is `[timestamp, clientId, cost]`. Timestamps are whole seconds and the log is sorted by timestamp (ties keep their log order). Process requests strictly in log order and decide each one before looking at the next.',
    },
    { t: 'h', text: 'Rules' },
    {
      t: 'list',
      ordered: true,
      items: [
        'A previously ACCEPTED request at time `s` is "live" for a request at time `t` when `t - s < window`. Rejected requests are never live — they cost nothing.',
        "Per-client limit: the live cost of the same client plus this request's cost must be `<= perClient`.",
        "Global limit: the live cost across all clients plus this request's cost must be `<= globalLimit`.",
        'Clients listed in `vip` are exempt from the per-client limit (rule 2) but still count toward, and are still bound by, the global limit (rule 3).',
        'A request is accepted only if every applicable rule passes; otherwise it is rejected. A request whose cost alone exceeds a limit that applies to it is always rejected.',
      ],
    },
    {
      t: 'p',
      text: 'Return the 0-based indices of all rejected requests in increasing order. Return an empty list if everything was accepted.',
    },
    {
      t: 'note',
      text: 'The window is a sliding window measured from each request\'s own timestamp — it is not aligned to fixed buckets such as "every 10 seconds".',
    },
    {
      t: 'example',
      input: `requests = [[0,"a",2],[1,"a",2],[2,"b",3],[3,"a",1],[10,"a",4]]
window = 10, perClient = 4, globalLimit = 6, vip = []`,
      output: '[2,3,4]',
    },
    {
      t: 'table',
      head: ['#', 'time', 'client', 'cost', 'live client cost', 'live global cost', 'result'],
      rows: [
        ['0', '0', 'a', '2', '0', '0', 'accepted'],
        ['1', '1', 'a', '2', '2', '2', 'accepted'],
        ['2', '2', 'b', '3', '0', '4', 'rejected (global 7 > 6)'],
        ['3', '3', 'a', '1', '4', '4', 'rejected (client 5 > 4)'],
        ['4', '10', 'a', '4', '2', '2', 'rejected (client 6 > 4)'],
      ],
    },
    {
      t: 'p',
      text: 'At time 10, request 0 (time 0) is no longer live because `10 - 0 = 10` is not `< 10`, but request 1 (time 1) still is.',
    },
    {
      t: 'example',
      input: `requests = [[0,"a",3],[0,"a",3],[1,"b",2],[4,"b",2],[5,"a",1],[6,"c",5]]
window = 5, perClient = 4, globalLimit = 7, vip = ["a"]`,
      output: '[2,3,5]',
      explanation:
        'Client "a" is VIP, so its two cost-3 requests at time 0 pass (global 6). Both "b" requests would take the global total to 8. At time 5 the time-0 requests have expired, so "a" is accepted again. Request 5 costs 5 on its own, which is above perClient.',
    },
    {
      t: 'example',
      input: `requests = [[0,"x",9],[1,"y",1],[2,"y",1],[3,"y",1],[3,"y",1]]
window = 3, perClient = 2, globalLimit = 10, vip = []`,
      output: '[0,3,4]',
    },
    { t: 'h', text: 'Constraints' },
    {
      t: 'list',
      items: [
        '`0 <= requests.length <= 2 * 10^4`',
        '`0 <= timestamp <= 10^9`, non-decreasing',
        '`1 <= cost <= 1000`',
        '`1 <= window <= 3600`',
        '`1 <= perClient <= globalLimit <= 10^6`',
        '`clientId` is 1–16 lowercase letters; `vip` has at most 50 entries',
      ],
    },
  ],
  fn: { python: 'rejected_requests', javascript: 'rejectedRequests' },
  params: ['requests', 'window', 'perClient', 'globalLimit', 'vip'],
  starter: {
    python: `from typing import List


def rejected_requests(
    requests: List[list],
    window: int,
    per_client: int,
    global_limit: int,
    vip: List[str],
) -> List[int]:
    # Write your code here
    pass
`,
    javascript: `/**
 * @param {[number, string, number][]} requests
 * @param {number} window
 * @param {number} perClient
 * @param {number} globalLimit
 * @param {string[]} vip
 * @return {number[]}
 */
function rejectedRequests(requests, window, perClient, globalLimit, vip) {
  // Write your code here
}
`,
  },
  tests: GATEWAY_CASES,
};

const plow: CodingQuestion = {
  id: 'q3',
  kind: 'coding',
  title: 'Snowplow Route',
  difficulty: 'Hard',
  points: 30,
  blocks: [
    {
      t: 'p',
      text: 'A city is modelled as an `R x C` grid. `grid[r][c] = 0` is a building the plow cannot enter; any positive value is the fuel needed to clear that street block. The plow starts at the top-left cell `(0, 0)` and must reach the bottom-right cell `(R-1, C-1)`.',
    },
    {
      t: 'p',
      text: 'Each move goes one cell up, down, left or right, and costs the value of the cell entered (the starting cell is free). Plows are slow to turn: whenever a move goes in a different direction from the previous move, add `turnCost` to that move. The first move may go in any direction without a turn penalty.',
    },
    {
      t: 'p',
      text: 'Return the minimum total fuel to reach the bottom-right cell, or `-1` if it cannot be reached. If the grid is a single cell, return `0`.',
    },
    {
      t: 'example',
      input: `grid = [[1,3,1,1],
        [1,0,0,1],
        [1,1,1,1]]
turnCost = 2`,
      output: '7',
      explanation:
        'Down twice (1 + 1), turn (+2), then right three times (1 + 1 + 1). Going right along the top first costs 3 + 1 + 1, then the turn, then 1 + 1 — that is 9.',
    },
    {
      t: 'example',
      input: `grid = [[1,2,3,4,5,6],
        [9,0,0,0,0,1],
        [9,1,1,1,0,1],
        [9,1,0,1,1,1],
        [9,9,9,9,9,1]]
turnCost = 3`,
      output: '27',
      explanation:
        'Right along the top row (2 + 3 + 4 + 5 + 6 = 20), one turn (+3), then down four cells (1 + 1 + 1 + 1). The path through the middle is cheaper per cell but needs too many turns.',
    },
    {
      t: 'example',
      input: `grid = [[5,0],
        [0,5]]
turnCost = 1`,
      output: '-1',
    },
    { t: 'h', text: 'Constraints' },
    {
      t: 'list',
      items: ['`1 <= R, C <= 200`', '`0 <= grid[r][c] <= 9`', '`0 <= turnCost <= 100`'],
    },
    { t: 'h', text: 'Follow-up' },
    {
      t: 'p',
      text: 'How would your solution change if a U-turn (reversing direction) cost `2 * turnCost`? You do not need to code this.',
    },
  ],
  fn: { python: 'min_plow_cost', javascript: 'minPlowCost' },
  params: ['grid', 'turnCost'],
  starter: {
    python: `from typing import List


def min_plow_cost(grid: List[List[int]], turn_cost: int) -> int:
    # Write your code here
    pass
`,
    javascript: `/**
 * @param {number[][]} grid
 * @param {number} turnCost
 * @return {number}
 */
function minPlowCost(grid, turnCost) {
  // Write your code here
}
`,
  },
  tests: PLOW_CASES,
};

const fundamentals: ChoiceQuestion = {
  id: 'q4',
  kind: 'choice',
  title: 'Fundamentals',
  points: 15,
  blocks: [{ t: 'p', text: 'Choose one answer for each question. Each is worth 5 points.' }],
  items: [
    {
      id: 'heap',
      prompt:
        'What is the worst-case time to build a binary heap from an unsorted array of n elements using bottom-up heapify?',
      options: ['O(log n)', 'O(n)', 'O(n log n)', 'O(n²)'],
      answer: 1,
    },
    {
      id: 'status',
      prompt:
        'A client calls DELETE /folders/42, but the folder still contains files, and the API refuses until it is empty. Which status code fits best?',
      options: ['400 Bad Request', '403 Forbidden', '409 Conflict', '422 Unprocessable Entity'],
      answer: 2,
    },
    {
      id: 'index',
      prompt:
        'The orders table has a composite index on (customer_id, created_at). Which query can NOT use it efficiently?',
      code: `-- A
SELECT * FROM orders WHERE customer_id = 7;
-- B
SELECT * FROM orders WHERE customer_id = 7 AND created_at > '2026-01-01';
-- C
SELECT * FROM orders WHERE created_at > '2026-01-01';
-- D
SELECT * FROM orders WHERE customer_id = 7 ORDER BY created_at DESC LIMIT 10;`,
      options: ['Query A', 'Query B', 'Query C', 'Query D'],
      answer: 2,
    },
  ],
};

const escalation: WrittenQuestion = {
  id: 'q5',
  kind: 'written',
  title: 'Escalation: "A seller was paid twice"',
  points: 15,
  blocks: [
    {
      t: 'note',
      text: 'Suggested time: 30–40 minutes. Write as you would to a real customer and a real engineering team.',
    },
    { t: 'h', text: 'Background (you do not need to know Northwind Ledger)' },
    {
      t: 'list',
      items: [
        '**Northwind Ledger** — our product. Online marketplaces use it to pay their sellers.',
        '**Marketplace** — our customer (here: Craftly, a handmade-goods marketplace).',
        '**Payout** — one transfer of money from the marketplace to one of its sellers, created with `POST /payouts`.',
        '**Idempotency-Key** — optional request header. Two requests with the same key must create only one payout.',
      ],
    },
    { t: 'h', text: 'The ticket' },
    {
      t: 'code',
      text: `From: Priya N., Head of Finance, Craftly
Subject: URGENT — seller paid twice

Yesterday one of our sellers (S-1182, "Juniper Pottery") received the same
payout twice: two bank transfers of €1,240.00 a few minutes apart. Our
dashboard only shows ONE payout (po_7Hc2). We send an Idempotency-Key on every
request. Is this a bug on your side? How many other sellers are affected, and
how do we get the money back? Our auditors are asking.`,
    },
    { t: 'h', text: 'What you have found so far' },
    {
      t: 'table',
      head: ['time (UTC)', 'source', 'event'],
      rows: [
        [
          'Nov 3 14:02:11',
          'api',
          'POST /payouts key=crf-88213 → 201 po_7Hc2 (seller S-1182, €1,240.00)',
        ],
        ['Nov 3 14:02:11', 'queue', 'publish payouts.send {payoutId: po_7Hc2} (attempt 1)'],
        ['Nov 3 14:02:12', 'worker', 'bank.transfer po_7Hc2 started'],
        ['Nov 3 14:02:42', 'queue', 'ack deadline exceeded → redeliver po_7Hc2 (attempt 2)'],
        ['Nov 3 14:02:43', 'worker', 'bank.transfer po_7Hc2 started'],
        ['Nov 3 14:02:46', 'worker', 'bank.transfer po_7Hc2 ok ref=BX-55120 (34.1 s)'],
        ['Nov 3 14:03:15', 'worker', 'bank.transfer po_7Hc2 ok ref=BX-55187 (32.0 s)'],
        ['Nov 3 13:40 – 15:10', 'status', 'Bank partner reported "elevated transfer latency"'],
        ['Nov 3 09:00', 'deploy', 'web-dashboard v412 (CSS changes only)'],
        [
          'Nov 3 all day',
          'craftly',
          'Their webhook endpoint returned HTTP 500 for 212 of our events',
        ],
      ],
    },
    { t: 'p', text: 'Relevant code (TypeScript):' },
    {
      t: 'code',
      text: `1   export async function createPayout(req: Request) {
2     const body = PayoutSchema.parse(req.body);
3     const key = req.headers['idempotency-key']
4       ?? \`\${body.sellerId}:\${body.amount}:\${Date.now()}\`;
5     const existing = await db.payouts.findByKey(key);
6     if (existing) return existing;
7
8     const payout = await db.payouts.insert({ ...body, key, status: 'pending' });
9     await queue.publish('payouts.send', { payoutId: payout.id });
10    return payout;
11  }
12
13  // Payout worker
14  queue.subscribe('payouts.send', async ({ payoutId }) => {
15    const payout = await db.payouts.get(payoutId);
16    await bank.transfer(payout.sellerId, payout.amount, payout.currency);
17    await db.payouts.update(payoutId, { status: 'paid' });
18  }, { ackDeadlineSeconds: 30, maxAttempts: 5 });`,
    },
    { t: 'h', text: 'Please submit' },
    {
      t: 'list',
      ordered: true,
      items: [
        'Your reply to Priya (max 200 words).',
        'The root cause, citing line numbers, and the fix you would ask engineering for. Mention any other bug you see in this code.',
        'How you would find every other affected payout, and what should happen with money already sent twice (max 150 words).',
        'One risk your fix itself could introduce (one or two sentences).',
      ],
    },
  ],
  parts: [
    { id: 'reply', label: '1 · Reply to the customer', maxWords: 200 },
    { id: 'cause', label: '2 · Root cause and fix', maxWords: 300 },
    { id: 'scope', label: '3 · Finding affected payouts', maxWords: 150 },
    { id: 'risk', label: '4 · Risk in the fix', maxWords: 60 },
  ],
};

export const NORTHWIND: PracticeTest = {
  id: 'northwind',
  storageKey: 'kestrel.practice.v1',
  info: {
    platform: 'Kestrel Assess',
    company: 'Northwind Ledger',
    name: 'Backend & Support Engineering — Online Assessment',
    minutes: 90,
  },
  questions: [bookings, gateway, plow, fundamentals, escalation],
};

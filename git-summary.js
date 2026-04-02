#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;
const CONFIG = JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, 'config.json'), 'utf8'));

// Parse args
let dryRun = false;
let lookbackHours = 24;

for (const arg of process.argv.slice(2)) {
  if (arg === '--dry-run') dryRun = true;
  if (arg.startsWith('--hours=')) lookbackHours = parseInt(arg.split('=')[1], 10);
}

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

// --- Data collection via gh CLI ---

function gh(args) {
  try {
    return execSync(`gh ${args}`, { encoding: 'utf8', timeout: 30000 }).trim();
  } catch (e) {
    return '';
  }
}

function ghJSON(args) {
  const raw = gh(args);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function collectGitData() {
  const org = CONFIG.org;
  const extraRepos = CONFIG.extraRepos || [];
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();

  // Get all repos in org
  const orgRepos = gh(`api "orgs/${org}/repos" --paginate --jq ".[].name"`)
    .split('\n')
    .filter(Boolean)
    .map((r) => `${org}/${r}`);

  const allRepos = [...orgRepos, ...extraRepos];
  log(`Found ${allRepos.length} repos to scan`);

  const data = {
    commits: [],
    prs: [],
    stalePRs: [],
    reviews: [],
    comments: [],
    issues: [],
    releases: [],
    branchEvents: [],
    memberEvents: [],
  };
  const seenSHAs = new Set();
  const commitBranches = new Map(); // SHA → Set of branch names

  for (const fullRepo of allRepos) {
    const repoName = fullRepo.split('/').pop();
    log(`Scanning ${fullRepo}...`);

    // Get branches
    const branches = gh(`api "repos/${fullRepo}/branches" --paginate --jq ".[].name"`)
      .split('\n')
      .filter(Boolean);

    if (branches.length === 0) {
      log(`  No branches in ${fullRepo}, skipping`);
      continue;
    }

    // 1. Commits from all branches, deduplicated by SHA
    for (const branch of branches) {
      const raw = gh(`api "repos/${fullRepo}/commits?since=${since}&sha=${branch}&per_page=100" --jq '.[] | [.sha, (.author.login // .commit.author.name // "unknown"), (.commit.message | split("\\n") | .[0])] | @tsv'`);
      if (!raw) continue;

      for (const line of raw.split('\n')) {
        if (!line) continue;
        const [sha, author, ...msgParts] = line.split('\t');
        const message = msgParts.join('\t');
        if (!sha) continue;
        if (!commitBranches.has(sha)) commitBranches.set(sha, new Set());
        commitBranches.get(sha).add(branch);
        if (seenSHAs.has(sha)) continue;
        seenSHAs.add(sha);
        data.commits.push({
          repo: repoName,
          fullRepo,
          author,
          branch,
          message,
          url: `https://github.com/${fullRepo}/commit/${sha}`,
        });
      }
    }

    // 2. PRs with reviews (created, merged, or closed in window)
    // Don't use updatedAt — bots (CI, Vercel, etc.) bump it constantly
    const prs = ghJSON(`pr list --repo "${fullRepo}" --state all --json number,title,author,state,createdAt,mergedAt,closedAt,reviews --limit 50`);
    const seenPRNumbers = new Set();
    if (prs) {
      for (const pr of prs) {
        const inWindow = pr.createdAt >= since
          || (pr.mergedAt && pr.mergedAt >= since)
          || (pr.closedAt && pr.closedAt >= since);
        if (!inWindow) continue;

        seenPRNumbers.add(pr.number);
        data.prs.push({
          repo: repoName,
          fullRepo,
          number: pr.number,
          title: pr.title,
          author: pr.author?.login || 'unknown',
          state: pr.state,
          createdAt: pr.createdAt?.slice(0, 10) || '',
          mergedAt: pr.mergedAt?.slice(0, 10) || '',
          closedAt: pr.closedAt?.slice(0, 10) || '',
          url: `https://github.com/${fullRepo}/pull/${pr.number}`,
        });

        // Extract reviews submitted in the time window
        for (const review of (pr.reviews || [])) {
          if (review.submittedAt >= since && review.state !== 'PENDING') {
            data.reviews.push({
              repo: repoName,
              prNumber: pr.number,
              prTitle: pr.title,
              reviewer: review.author?.login || 'unknown',
              state: review.state,
            });
          }
        }
      }
    }

    // Also fetch all open PRs — to find stale ones and catch PRs with recent commits
    const openPrs = ghJSON(`pr list --repo "${fullRepo}" --state open --json number,title,author,state,createdAt,reviews --limit 50`);
    if (openPrs) {
      for (const pr of openPrs) {
        if (seenPRNumbers.has(pr.number)) continue;

        const prData = {
          repo: repoName,
          fullRepo,
          number: pr.number,
          title: pr.title,
          author: pr.author?.login || 'unknown',
          state: pr.state,
          createdAt: pr.createdAt?.slice(0, 10) || '',
          mergedAt: '',
          closedAt: '',
          url: `https://github.com/${fullRepo}/pull/${pr.number}`,
        };

        // Check if this PR has commits in the window (matched later in formatRawData)
        // For now, add to a separate list — will be promoted to active or flagged as stale
        data.stalePRs.push(prData);

        // Extract reviews submitted in the time window
        for (const review of (pr.reviews || [])) {
          if (review.submittedAt >= since && review.state !== 'PENDING') {
            data.reviews.push({
              repo: repoName,
              prNumber: pr.number,
              prTitle: pr.title,
              reviewer: review.author?.login || 'unknown',
              state: review.state,
            });
          }
        }
      }
    }

    // 3. Issue and PR comments (general discussion comments)
    const commentsRaw = ghJSON(`api "repos/${fullRepo}/issues/comments?since=${since}&per_page=100"`);
    if (commentsRaw) {
      for (const c of commentsRaw) {
        const num = c.issue_url?.match(/\/(\d+)$/)?.[1];
        data.comments.push({
          repo: repoName,
          author: c.user?.login || 'unknown',
          issueNumber: num || '?',
          body: (c.body || '').split('\n')[0].slice(0, 120),
          createdAt: c.created_at,
        });
      }
    }

    // 4. PR review comments (inline code review comments)
    const reviewCommentsRaw = ghJSON(`api "repos/${fullRepo}/pulls/comments?since=${since}&per_page=100"`);
    if (reviewCommentsRaw) {
      for (const c of reviewCommentsRaw) {
        const prNum = c.pull_request_url?.match(/\/(\d+)$/)?.[1];
        data.comments.push({
          repo: repoName,
          author: c.user?.login || 'unknown',
          issueNumber: prNum || '?',
          body: (c.body || '').split('\n')[0].slice(0, 120),
          createdAt: c.created_at,
          isReviewComment: true,
        });
      }
    }

    // 5. Issues (exclude PRs — they have pull_request key)
    const issuesRaw = ghJSON(`api "repos/${fullRepo}/issues?since=${since}&state=all&per_page=100"`);
    if (issuesRaw) {
      for (const issue of issuesRaw) {
        if (issue.pull_request) continue;
        data.issues.push({
          repo: repoName,
          number: issue.number,
          title: issue.title,
          author: issue.user?.login || 'unknown',
          state: issue.state,
          createdAt: issue.created_at?.slice(0, 10) || '',
          url: issue.html_url,
        });
      }
    }

    // 6. Releases
    const releasesRaw = ghJSON(`api "repos/${fullRepo}/releases?per_page=10"`);
    if (releasesRaw) {
      for (const rel of releasesRaw) {
        if (rel.published_at >= since) {
          data.releases.push({
            repo: repoName,
            tag: rel.tag_name,
            name: rel.name || rel.tag_name,
            author: rel.author?.login || 'unknown',
            publishedAt: rel.published_at?.slice(0, 10) || '',
            url: rel.html_url,
          });
        }
      }
    }
  }

  // 7. Org events — branch create/delete and membership changes
  log('Fetching org events...');
  const events = ghJSON(`api "orgs/${org}/events?per_page=100"`);
  if (events) {
    for (const ev of events) {
      if (ev.created_at < since) continue;
      const repoName = ev.repo?.name?.replace(`${org}/`, '') || '';

      if (ev.type === 'CreateEvent' && ev.payload?.ref_type === 'branch') {
        data.branchEvents.push({
          repo: repoName,
          author: ev.actor?.login || 'unknown',
          action: 'created',
          branch: ev.payload.ref,
        });
      } else if (ev.type === 'DeleteEvent' && ev.payload?.ref_type === 'branch') {
        data.branchEvents.push({
          repo: repoName,
          author: ev.actor?.login || 'unknown',
          action: 'deleted',
          branch: ev.payload.ref,
        });
      } else if (ev.type === 'MemberEvent') {
        data.memberEvents.push({
          repo: repoName,
          member: ev.payload?.member?.login || 'unknown',
          action: ev.payload?.action || 'added',
          actor: ev.actor?.login || 'unknown',
        });
      }
    }
  }

  // Deduplicate comments (issues/comments and pulls/comments can overlap)
  const commentKeys = new Set();
  data.comments = data.comments.filter((c) => {
    const key = `${c.repo}:${c.author}:${c.issueNumber}:${c.createdAt}`;
    if (commentKeys.has(key)) return false;
    commentKeys.add(key);
    return true;
  });

  // Fetch commit SHAs per PR (active + stale candidates) for accurate matching
  log('Fetching commit SHAs per PR...');
  const prCommitSHAs = new Map(); // "repo:#number" → Set of SHAs
  for (const pr of [...data.prs, ...data.stalePRs]) {
    const shas = gh(`api "repos/${pr.fullRepo}/pulls/${pr.number}/commits?per_page=100" --jq ".[].sha"`);
    if (shas) {
      prCommitSHAs.set(`${pr.repo}:#${pr.number}`, new Set(shas.split('\n').filter(Boolean)));
    }
  }
  data._prCommitSHAs = prCommitSHAs;
  data._commitBranches = commitBranches;

  log(`Collected: ${data.commits.length} commits, ${data.prs.length} PRs, ${data.stalePRs.length} open PRs to check, ${data.reviews.length} reviews, ${data.comments.length} comments, ${data.issues.length} issues, ${data.releases.length} releases, ${data.branchEvents.length} branch events, ${data.memberEvents.length} membership changes`);

  return data;
}

function formatRawData(data, authorMap, ticketPattern) {
  const n = (author) => authorMap[author] || author;
  const lines = [];

  // SHA-based commit matching per PR
  const prCommitSHAs = data._prCommitSHAs || new Map();
  const commitBySHA = new Map();
  for (const c of data.commits) {
    const sha = c.url.split('/').pop();
    commitBySHA.set(sha, c);
  }

  // Index reviews and comments by PR
  const reviewsByPR = new Map();
  for (const r of data.reviews) {
    const key = `${r.repo}:#${r.prNumber}`;
    if (!reviewsByPR.has(key)) reviewsByPR.set(key, []);
    reviewsByPR.get(key).push(r);
  }
  const commentsByPR = new Map();
  for (const c of data.comments) {
    const key = `${c.repo}:#${c.issueNumber}`;
    if (!commentsByPR.has(key)) commentsByPR.set(key, []);
    commentsByPR.get(key).push(c);
  }

  // Group all data by person
  const people = new Map();
  const ensure = (author) => {
    const name = n(author);
    if (!people.has(name)) people.set(name, { prs: [], directCommits: [], releases: [], branches: [], issues: [] });
    return people.get(name);
  };

  // Assign PRs to their authors, with reviews and comments attached
  for (const pr of data.prs) {
    const person = ensure(pr.author);
    let status = pr.state;
    if (pr.mergedAt) status = `MERGED ${pr.mergedAt}`;
    else if (pr.closedAt) status = `CLOSED ${pr.closedAt}`;

    const prKey = `${pr.repo}:#${pr.number}`;
    const reviews = (reviewsByPR.get(prKey) || []).map(
      (r) => `${n(r.reviewer)}: ${r.state}`
    );
    const comments = (commentsByPR.get(prKey) || []).map(
      (c) => `${n(c.author)}: ${c.body}`
    );

    // Find commits that belong to this PR by SHA matching
    const shas = prCommitSHAs.get(prKey) || new Set();
    const prCommits = data.commits.filter((c) => {
      const sha = c.url.split('/').pop();
      return shas.has(sha);
    });

    person.prs.push({
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
      status,
      url: pr.url,
      createdAt: pr.createdAt,
      commits: prCommits.map((c) => `${c.message} | ${c.url}`),
      reviews,
      comments,
    });
  }

  // Check stalePRs — promote to active if they have any recent activity, otherwise keep as stale
  const remainingStalePRs = [];
  for (const pr of data.stalePRs) {
    const prKey = `${pr.repo}:#${pr.number}`;
    const shas = prCommitSHAs.get(prKey) || new Set();
    const prCommits = data.commits.filter((c) => {
      const sha = c.url.split('/').pop();
      return shas.has(sha);
    });
    const prReviews = reviewsByPR.get(prKey) || [];
    const prComments = commentsByPR.get(prKey) || [];

    const hasRecentActivity = prCommits.length > 0 || prReviews.length > 0 || prComments.length > 0;

    if (hasRecentActivity) {
      // Has recent activity — promote to active
      const person = ensure(pr.author);
      person.prs.push({
        repo: pr.repo,
        number: pr.number,
        title: pr.title,
        status: 'OPEN',
        url: pr.url,
        createdAt: pr.createdAt,
        commits: prCommits.map((c) => `${c.message} | ${c.url}`),
        reviews: prReviews.map((r) => `${n(r.reviewer)}: ${r.state}`),
        comments: prComments.map((c) => `${n(c.author)}: ${c.body}`),
      });
    } else {
      // No recent activity — stale
      remainingStalePRs.push(pr);
    }
  }

  // Collect commit SHAs already assigned to PRs
  const assignedCommitUrls = new Set();
  for (const [, person] of people) {
    for (const pr of person.prs) {
      for (const c of pr.commits) {
        assignedCommitUrls.add(c.split(' | ').pop());
      }
    }
  }

  // Direct pushes to main (commits not matched to any PR)
  // Exclude merge/squash commits — they reference a PR number in the message e.g. "(#123)"
  const knownPRNumbers = new Set();
  for (const pr of [...data.prs, ...data.stalePRs]) {
    knownPRNumbers.add(`${pr.repo}:#${pr.number}`);
  }
  const commitBranchesMap = data._commitBranches || new Map();
  for (const c of data.commits) {
    if (assignedCommitUrls.has(c.url)) continue;
    const sha = c.url.split('/').pop();
    const branches = commitBranchesMap.get(sha) || new Set();
    if (branches.has('main') || branches.has('master')) {
      // Check if this is a PR merge commit
      // Matches: squash "title (#NNN)", merge "Merge pull request #NNN", or rebase with "(#NNN)"
      const prRef = c.message.match(/\(#(\d+)\)/) || c.message.match(/^Merge pull request #(\d+)\b/);
      if (prRef && knownPRNumbers.has(`${c.repo}:#${prRef[1]}`)) continue;

      const person = ensure(c.author);
      person.directCommits.push(`[${c.repo}] ${c.message} | ${c.url}`);
    }
  }

  // Issues — try to match to a PR by repo + similar number references, otherwise standalone
  for (const issue of data.issues) {
    const person = ensure(issue.author);
    person.issues.push({
      repo: issue.repo,
      number: issue.number,
      title: issue.title,
      state: issue.state,
      url: issue.url,
    });
  }

  // Releases
  for (const r of data.releases) {
    const person = ensure(r.author);
    person.releases.push(`[${r.repo}] ${r.tag} "${r.name}" | ${r.publishedAt} | ${r.url}`);
  }

  // Branch events
  for (const b of data.branchEvents) {
    const person = ensure(b.author);
    person.branches.push(`[${b.repo}] ${b.action} branch: ${b.branch}`);
  }

  // Format output per person
  for (const [name, person] of people) {
    lines.push(`=== ${name} ===`);

    for (const pr of person.prs) {
      lines.push(`  PR #${pr.number}: ${pr.title} [${pr.status}] (${pr.repo}) | ${pr.url}`);
      if (pr.commits.length > 0) {
        // Group commits by ticket reference
        const ticketRegex = ticketPattern ? new RegExp(ticketPattern, 'gi') : null;
        const byTicket = new Map(); // ticket → [commit messages]
        const noTicket = [];

        for (const c of pr.commits) {
          const msg = c.split(' | ')[0]; // commit message without URL
          const url = c.split(' | ').slice(1).join(' | ');
          const matches = ticketRegex ? msg.match(ticketRegex) : null;
          if (matches) {
            const ticket = matches[0].toUpperCase();
            if (!byTicket.has(ticket)) byTicket.set(ticket, []);
            byTicket.get(ticket).push({ msg, url });
          } else {
            noTicket.push({ msg, url });
          }
        }

        for (const [ticket, commits] of byTicket) {
          lines.push(`    ${ticket} (${commits.length} commits):`);
          for (const c of commits) {
            lines.push(`      ${c.msg} | ${c.url}`);
          }
        }
        if (noTicket.length > 0) {
          lines.push(`    Other commits (${noTicket.length}):`);
          for (const c of noTicket) {
            lines.push(`      ${c.msg} | ${c.url}`);
          }
        }
      }
      if (pr.reviews.length > 0) {
        lines.push(`    Reviews: ${pr.reviews.join(', ')}`);
      }
      if (pr.comments.length > 0) {
        lines.push(`    Comments:`);
        for (const c of pr.comments) {
          lines.push(`      ${c}`);
        }
      }
    }

    if (person.directCommits.length > 0) {
      lines.push(`  ⚠️ DIRECT PUSHES TO MAIN (${person.directCommits.length}):`);
      for (const c of person.directCommits) {
        lines.push(`    ${c}`);
      }
    }

    if (person.issues.length > 0) {
      lines.push(`  Issues:`);
      for (const i of person.issues) {
        lines.push(`    [${i.state}] #${i.number}: ${i.title} | ${i.url}`);
      }
    }

    if (person.releases.length > 0) {
      lines.push(`  Releases:`);
      for (const r of person.releases) {
        lines.push(`    ${r}`);
      }
    }

    if (person.branches.length > 0) {
      lines.push(`  Branches:`);
      for (const b of person.branches) {
        lines.push(`    ${b}`);
      }
    }

    lines.push('');
  }

  // Stale PRs — open with no recent activity, capped at 7
  if (remainingStalePRs.length > 0) {
    lines.push('=== STALE PRs (open, no recent activity) ===');
    const shown = remainingStalePRs.slice(0, 7);
    for (const pr of shown) {
      const age = Math.floor((Date.now() - new Date(pr.createdAt).getTime()) / (1000 * 60 * 60 * 24));
      lines.push(`  [${pr.repo}] #${pr.number}: ${pr.title} by ${n(pr.author)} — open ${age} days | ${pr.url}`);
    }
    if (remainingStalePRs.length > 7) {
      lines.push(`  ... and ${remainingStalePRs.length - 7} more stale PRs`);
    }
    lines.push('');
  }

  // Membership changes (org-level, not person-specific)
  if (data.memberEvents.length > 0) {
    lines.push('=== MEMBERSHIP CHANGES ===');
    for (const m of data.memberEvents) {
      lines.push(`[${m.repo}] ${n(m.member)} was ${m.action} by ${n(m.actor)}`);
    }
  }

  return lines.join('\n');
}

// --- Gemini Flash via OpenRouter: pre-process raw data (optional) ---

async function preprocessWithGemini(openrouterApiKey, rawData, authorMap) {
  const authorMapStr = Object.entries(authorMap).map(([k, v]) => `${k} → ${v}`).join(', ');
  const ticketPattern = CONFIG.ticketPattern || '';

  const prompt = `You are a data organizer. Process this raw GitHub activity data into a structured summary grouped by person.

Author mapping: ${authorMapStr}

${rawData}

TASK: Organize ALL activity by person (use display names from mapping). The data is already grouped by person and PR-centric. For each person:

1. PRs are the primary unit. Each PR should show: number, title, state, repo, URL.
   - Commits belonging to the PR are listed under it — summarize into themes with count.
   - Reviews on the PR are listed under it — who reviewed and verdict.
   - Comments on the PR are listed under it — summarize the discussion briefly.
   ${ticketPattern ? `- Connect PRs to tickets: if a ${ticketPattern} pattern appears in the PR title, branch, or commits, note the ticket. If no explicit ticket reference exists but the PR clearly relates to a known ticket based on its content, note it with "(AI-matched)".` : ''}
   - If no ticket reference can be found or inferred for a PR, flag with "⚠️ no ticket linked".
2. Direct pushes to main are flagged separately — these should be called out.
3. Issues should be connected to the PR they're addressed by if possible.
4. Releases and branch events listed after PRs.

Output ONLY the structured data — no commentary, no formatting instructions. Keep it concise but complete. Use plain text, not markdown.`;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openrouterApiKey}`,
    },
    body: JSON.stringify({
      model: 'google/gemini-2.5-flash',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2500,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter error: ${res.status} — ${body}`);
  }

  const json = await res.json();
  return json.choices?.[0]?.message?.content?.trim() || '';
}

// --- Final LLM call: generate Slack message ---

function generateSlackSummary(structuredData, isPreprocessed) {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const ticketPattern = CONFIG.ticketPattern || '';
  const llmCommand = CONFIG.llmCommand || 'claude -p -';

  // Load context if available
  const contextPath = path.join(SCRIPT_DIR, 'context.md');
  const context = fs.existsSync(contextPath) ? fs.readFileSync(contextPath, 'utf8') : '';

  const contextBlock = context ? `\nPROJECT CONTEXT:\n${context}\n` : '';
  const dataLabel = isPreprocessed ? 'ORGANIZED ACTIVITY DATA' : 'RAW ACTIVITY DATA';

  const prompt = `You are a dev activity summarizer. Generate a Slack daily summary from this ${isPreprocessed ? 'pre-organized' : 'raw'} data.
${contextBlock}
Date: ${yesterday}

${dataLabel}:
${structuredData}

FORMAT RULES:
- Use Slack mrkdwn (*bold*, _italic_, \`code\`)
- For links use Slack format: <URL|display text>
- Start with: *Daily Dev Summary — ${yesterday}*
- Group by person. Format per person:
  *Person Name*
  <pr_url|*repo #number*> — *Title* — \`state\`${ticketPattern ? ` — link to ticket if ${ticketPattern} pattern found in PR title/branch/commits. If no explicit reference but the PR clearly relates to a known ticket based on context, note it with _(AI-matched)_.` : ''} If no ticket reference can be found or inferred for a PR, flag with ⚠️ _no ticket linked_
  • Commit summary (count + brief theme). Every PR MUST have at least one bullet underneath — if no commits, summarize recent activity (comments, reviews) or briefly describe what the PR does.
  • Reviews: who reviewed + verdict (only if applicable)
  • Discussion summary (only if applicable)
  (next PR for same person follows directly)
  ───────────────
  (divider AFTER each person's section, before the next person)
- PRs are plain lines (no bullet). Sub-items (commits, reviews, discussion) are bullet points (•) indented under the PR.
- Commits are grouped by ticket reference in the data. Distinguish between:
  a) The PR's *target ticket* — the ticket the PR is actually working on (typically in the PR title or referenced by most commits). Show as the PR's ticket on the PR line.
  b) *Referenced tickets* — mentioned in a commit as context but not the focus of this PR. Show as a brief mention: "references TICKET" — do NOT say "X commits for TICKET" if the PR isn't working on that ticket.
  Show each distinct group of commits as a separate bullet with count + summary. Do NOT merge all commits into one line.
- After PRs, if the person pushed directly to main, flag with ⚠️: *Direct pushes to main:* — summarize what was pushed
- Releases and branch events as separate bullets after PRs
- Reviews appear ONLY under the PR author's section (not duplicated under the reviewer). Mention who reviewed.
- Issues should be connected to the PR that addresses them, not listed separately
- If there are stale PRs (open with no recent activity), add a *🕸 Stale PRs:* section at the end — list each with repo, PR number+link, title, author, and age in days
- End with a *Notable:* line — one sentence on the main theme of the day
- Omit sections that would be empty
- Output ONLY the Slack message — no code blocks, no explanation, no prefix/suffix`;

  try {
    return execSync(llmCommand, {
      input: prompt,
      encoding: 'utf8',
      timeout: 120000,
    }).trim();
  } catch (e) {
    throw new Error(`LLM failed (${llmCommand}): ${e.message}`);
  }
}

// --- Main ---

async function main() {
  const webhookUrl = CONFIG.slackWebhookUrl;
  if (!dryRun && (!webhookUrl || webhookUrl.includes('XXXXX'))) {
    log('ERROR: slackWebhookUrl not configured');
    process.exit(1);
  }

  // Step 1: Collect all GitHub data
  const data = collectGitData();

  const totalActivity = data.commits.length + data.prs.length + data.reviews.length
    + data.comments.length + data.issues.length + data.releases.length
    + data.branchEvents.length + data.memberEvents.length;

  if (totalActivity === 0) {
    log('No activity found. Skipping summary.');
    process.exit(0);
  }

  const authorMap = CONFIG.authorMap || {};
  const ticketPattern = CONFIG.ticketPattern || '';
  const rawData = formatRawData(data, authorMap, ticketPattern);

  // Step 2: Gemini Flash pre-processing (optional — only if OPENROUTER_API_KEY is set)
  const openrouterApiKey = process.env.OPENROUTER_API_KEY;
  let structuredData = rawData;
  let isPreprocessed = false;

  if (openrouterApiKey) {
    log('Running Gemini Flash pre-processing...');
    try {
      const result = await preprocessWithGemini(openrouterApiKey, rawData, authorMap);
      if (result) {
        structuredData = result;
        isPreprocessed = true;
      } else {
        log('Gemini returned empty result, using raw data...');
      }
    } catch (e) {
      log(`Gemini pre-processing failed: ${e.message}`);
      log('Falling back to raw data...');
    }
  } else {
    log('No OPENROUTER_API_KEY — skipping Gemini pre-processing, using raw data...');
  }

  // Step 3: Final LLM — polished Slack message
  const llmCommand = CONFIG.llmCommand || 'claude -p -';
  log(`Running LLM summary (${llmCommand})...`);
  const summary = generateSlackSummary(structuredData, isPreprocessed);

  if (!summary) {
    log('ERROR: Empty summary from LLM');
    process.exit(1);
  }

  if (dryRun) {
    log('DRY RUN — would post to Slack:');
    console.log('---');
    console.log(summary);
    console.log('---');
    console.log('');
    if (isPreprocessed) {
      console.log('Gemini structured data:');
      console.log(structuredData);
      console.log('');
    }
    console.log(`Raw: ${data.commits.length} commits, ${data.prs.length} PRs, ${data.reviews.length} reviews, ${data.comments.length} comments, ${data.issues.length} issues, ${data.releases.length} releases, ${data.branchEvents.length} branch events, ${data.memberEvents.length} membership`);
    process.exit(0);
  }

  // Post to Slack
  const payload = JSON.stringify({ text: summary });
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  });

  if (res.ok) {
    log('Posted to Slack successfully');
  } else {
    log(`ERROR: Slack returned HTTP ${res.status}`);
    process.exit(1);
  }
}

main().catch((e) => {
  log(`ERROR: ${e.message}`);
  process.exit(1);
});

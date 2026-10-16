// The git side of Time Machine: snapshots of the working tree as commits no branch points
// at, and a move of the working tree from one of them to another.
//
// Everything goes through `run(argv, init)`, shaped like `$.process.run`, so the mod hands
// it the engine and the tests hand it a real git on a temporary repository.
//
// - A snapshot stages the whole working tree (tracked, changed and untracked files, not the
//   ignored ones) into an index of its own (`repo.index`, one per session), beside the
//   repository's, so the person's staging area, HEAD and branches are never touched.
// - Each snapshot is a commit kept alive by a ref under refs/time-machine/, not by a
//   branch: `git log` never shows it, and `prune` drops the old ones.
// - `move` takes the working tree from one tree to another with `read-tree -m -u`: files the
//   target lacks are removed, files it has are written. The caller snapshots first whatever
//   it wants to keep a way back to. An ignored file is never in a snapshot, so a move that
//   would write over one refuses (MoveBlocked) instead of losing it.

export const REF_ROOT = 'refs/time-machine'
const INDEX = 'time-machine.index'
// Snapshots are no one's commits: a fixed identity, so a repository without user.name works
const IDENTITY = {
  GIT_AUTHOR_NAME: 'time-machine',
  GIT_AUTHOR_EMAIL: 'time-machine@localhost',
  GIT_COMMITTER_NAME: 'time-machine',
  GIT_COMMITTER_EMAIL: 'time-machine@localhost'
}
const TIMEOUT_MS = 120_000
// The HEAD each index was last seeded from: while HEAD stays, the index already holds it, and
// seeding again would only make git hash the changed files again
const seededFrom = new Map()

/** A move that would write over ignored files, which no snapshot holds: `paths` are they. */
export class MoveBlocked extends Error {
  /** @param {string[]} paths */
  constructor (paths) {
    super(`it would write over ignored files: ${paths.join(', ')}`)
    this.name = 'MoveBlocked'
    this.paths = paths
  }
}

/** Runs git and gives its trimmed output, or throws with what git said. */
async function git (run, argv, init = {}) {
  const result = await run(['git', ...argv], { timeoutMs: TIMEOUT_MS, ...init })
  if (result.exitCode !== 0) {
    const said = (result.stderr || result.stdout || '').trim().split('\n')[0]
    throw new Error(`git ${argv[0]}: ${said || `exit ${result.exitCode}`}`)
  }
  return result.stdout.trim()
}

/** The repository the session works in, or null outside one. */
export async function locate (run, cwd) {
  try {
    const top = await git(run, ['rev-parse', '--show-toplevel'], { cwd })
    const gitDir = await git(run, ['rev-parse', '--absolute-git-dir'], { cwd })
    return { top, gitDir }
  } catch {
    return null
  }
}

// Time Machine's own index: the session's when the caller names one, else one per repository
const indexOf = repo => repo.index ?? `${repo.gitDir}/${INDEX}`

function indexEnv (repo) {
  return { ...IDENTITY, GIT_INDEX_FILE: indexOf(repo) }
}

/** The working tree as a tree object, through Time Machine's own index: `{ tree, head }`. */
export async function treeOf (run, repo) {
  const init = { cwd: repo.top, env: indexEnv(repo) }
  const index = indexOf(repo)
  const head = await headOf(run, repo)
  // The index is seeded from HEAD, so a tracked file the .gitignore matches stays in it, and
  // seeded again when HEAD moves (a commit, a checkout); a one-tree merge keeps the stat data
  // of the entries HEAD has unchanged
  if (head !== null && seededFrom.get(index) !== head) {
    // A missing index starts as a copy of the repository's: it carries the stat data of every
    // file, so git hashes only what changed instead of the whole tree (12.8k files: 424 ms to
    // 96). Where `cp` cannot start (Windows outside Git Bash) it starts empty, just slower
    if (!seededFrom.has(index)) await run(['cp', '-n', `${repo.gitDir}/index`, index], { cwd: repo.top }).catch(() => undefined)
    // A copy taken mid-merge holds unmerged entries, which a one-tree merge refuses for good:
    // then the index starts over from HEAD, without the stat data
    await git(run, ['read-tree', '-m', 'HEAD'], init).catch(() => git(run, ['read-tree', 'HEAD'], init))
    seededFrom.set(index, head)
  }
  await git(run, ['add', '-A', '--', '.'], init)
  await untrackIgnored(run, repo, head, init)
  return { tree: await git(run, ['write-tree'], init), head }
}

/**
 * A file the index holds stays in it after the .gitignore starts matching it: a .env saved
 * once, then ignored, would carry every secret written to it into the snapshots. Such files
 * leave the index, unless HEAD tracks them (then they are the repository's to keep).
 */
async function untrackIgnored (run, repo, head, init) {
  const ignored = (await git(run, ['ls-files', '-z', '--cached', '--ignored', '--exclude-standard'], init)).split('\0').filter(Boolean)
  if (ignored.length === 0) return
  let leave = ignored
  if (head !== null) {
    // `missing` for each path HEAD does not have, in one process
    const found = await git(run, ['cat-file', '--batch-check'], { cwd: repo.top, stdin: ignored.map(path => `${head}:${path}\n`).join('') })
    const lines = found.split('\n')
    leave = ignored.filter((_, i) => lines[i]?.endsWith(' missing'))
  }
  if (leave.length === 0) return
  await git(run, ['rm', '-q', '--cached', '--pathspec-from-file=-', '--pathspec-file-nul'], { ...init, stdin: leave.map(path => `:(literal)${path}`).join('\0') })
}

async function headOf (run, repo) {
  const result = await run(['git', 'rev-parse', '-q', '--verify', 'HEAD'], { cwd: repo.top })
  return result.exitCode === 0 ? result.stdout.trim() : null
}

/** Keeps tree `tree` as a commit held by `ref` (its parent HEAD, when there is one). */
export async function keep (run, repo, { tree, head }, ref, message) {
  const parent = head ? ['-p', head] : []
  const commit = await git(run, ['commit-tree', tree, ...parent, '-m', message], { cwd: repo.top, env: IDENTITY })
  await git(run, ['update-ref', ref, commit], { cwd: repo.top })
  return commit
}

/** Snapshots the working tree as a commit kept by `ref`: `{ tree, commit }`. */
export async function snapshot (run, repo, ref, message) {
  const now = await treeOf(run, repo)
  return { tree: now.tree, commit: await keep(run, repo, now, ref, message) }
}

/**
 * A git listing in `-z` form, whole entries only: past the engine's 4 MiB of output the last
 * entry is cut in the middle, so it goes (a change of 50,000 files lists a few less, rather
 * than a path that does not exist).
 */
async function whole (run, repo, argv) {
  const result = await run(['git', ...argv], { cwd: repo.top, timeoutMs: TIMEOUT_MS })
  if (result.exitCode !== 0) throw new Error(`git ${argv[0]}: ${(result.stderr || '').trim().split('\n')[0] || `exit ${result.exitCode}`}`)
  if (!result.isStdoutTruncated) return result.stdout
  return result.stdout.slice(0, result.stdout.lastIndexOf('\0') + 1)
}

/** What changed from tree `a` to tree `b`: `[{ path, status, added, removed }]`. */
export async function changes (run, repo, a, b) {
  if (a === b) return []
  const numstat = await whole(run, repo, ['diff', '--numstat', '--no-renames', '-z', a, b])
  const status = await whole(run, repo, ['diff', '--name-status', '--no-renames', '-z', a, b])
  const statusOf = new Map()
  const parts = status.split('\0').filter(Boolean)
  for (let i = 0; i + 1 < parts.length; i += 2) statusOf.set(parts[i + 1], parts[i])
  return numstat.split('\0').filter(Boolean).map(line => {
    const [added, removed, path] = line.split('\t')
    return {
      path,
      status: statusOf.get(path) ?? 'M',
      // Binary files count as "-" in numstat
      added: added === '-' ? null : Number(added),
      removed: removed === '-' ? null : Number(removed)
    }
  })
}

/**
 * Takes the working tree from tree `from` to tree `to`, and gives what moved. `from` has to
 * be the tree `treeOf` just gave: Time Machine's index then matches the working tree, and a
 * two-tree merge from it is a fast-forward of the files, removals included.
 */
export async function move (run, repo, from, to) {
  if (from === to) return []
  const moved = await changes(run, repo, from, to)
  // Only a file the target adds can land on an ignored one (everything else is in `from`)
  const added = moved.filter(file => file.status === 'A').map(file => file.path)
  if (added.length > 0) {
    // Which of them the .gitignore matches, in one process (exit 1: none does)…
    const checked = await run(['git', 'check-ignore', '-z', '--stdin'], { cwd: repo.top, stdin: added.join('\0') + '\0', timeoutMs: TIMEOUT_MS })
    if (checked.exitCode > 1) throw new Error(`git check-ignore: ${checked.stderr.trim().split('\n')[0]}`)
    const ignored = checked.stdout.split('\0').filter(Boolean)
    // …and of those, which are on disk: the ones the move would write over
    const blocked = ignored.length === 0 ? [] : (await git(run, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...ignored.map(path => `:(literal)${path}`)], { cwd: repo.top })).split('\0').filter(Boolean)
    if (blocked.length > 0) throw new MoveBlocked(blocked)
  }
  await git(run, ['read-tree', '-m', '-u', from, to], { cwd: repo.top, env: indexEnv(repo) })
  return moved
}

/** Points `ref` at `commit`, so git keeps it. */
export async function pin (run, repo, ref, commit) {
  await git(run, ['update-ref', ref, commit], { cwd: repo.top })
}

/** Drops a snapshot's ref; its commit goes with git's next gc. */
export async function drop (run, repo, ref) {
  await run(['git', 'update-ref', '-d', ref], { cwd: repo.top })
}

/** Drops every snapshot older than `maxAgeMs`, in one process however many; gives how many went. */
export async function prune (run, repo, now, maxAgeMs) {
  const list = await git(run, ['for-each-ref', '--format=%(refname) %(committerdate:unix)', REF_ROOT], { cwd: repo.top })
  const old = list.split('\n').filter(Boolean).map(line => line.split(' ')).filter(([, seconds]) => now - Number(seconds) * 1000 > maxAgeMs)
  if (old.length > 0) await git(run, ['update-ref', '--stdin'], { cwd: repo.top, stdin: old.map(([ref]) => `delete ${ref}\n`).join('') })
  return old.length
}

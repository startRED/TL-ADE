/**
 * @param {string} path
 */
function normalizePath(path) {
  return path.replace(/^[ab]\//, '');
}

/**
 * @param {string} patch
 * @returns {Array<{path: string, lines: Array<{type: 'add'|'del'|'ctx'|'hunk', text: string}>}>}
 */
export function parseDiff(patch) {
  if (typeof patch !== 'string') {
    throw new TypeError('patch deve ser uma string');
  }

  const files = [];
  const blocks = patch.split(/^diff --git .+$/m);
  blocks.shift();

  for (const block of blocks) {
    const source = block.replace(/^\n/, '');
    const blockLines = source.split('\n');
    if (blockLines.at(-1) === '') {
      blockLines.pop();
    }

    if (blockLines.some((line) => line === 'GIT binary patch' || /^Binary files .+ differ$/.test(line))) {
      continue;
    }

    let beforeHunk = true;
    let oldPath = null;
    let newPath = null;
    const lines = [];

    for (const line of blockLines) {
      if (beforeHunk) {
        if (line.startsWith('--- ')) {
          oldPath = line.slice(4);
          continue;
        }
        if (line.startsWith('+++ ')) {
          newPath = line.slice(4);
          continue;
        }
        if (line.startsWith('@@')) {
          beforeHunk = false;
          lines.push({ type: 'hunk', text: line });
        }
        continue;
      }

      if (line.startsWith('@@')) {
        lines.push({ type: 'hunk', text: line });
      } else if (line.startsWith('+')) {
        lines.push({ type: 'add', text: line });
      } else if (line.startsWith('-')) {
        lines.push({ type: 'del', text: line });
      } else {
        lines.push({ type: 'ctx', text: line });
      }
    }

    const path = newPath === '/dev/null' ? oldPath : newPath;
    if (path && lines.length > 0) {
      files.push({ path: normalizePath(path), lines });
    }
  }

  return files;
}

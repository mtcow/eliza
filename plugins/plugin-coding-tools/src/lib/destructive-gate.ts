/**
 * Destructive-bulk command classifier for the chat-path SHELL gate. Decides
 * whether a command is an irreversible bulk operation (recursive delete, disk
 * overwrite, database drop) that must be confirmed by the user before it runs.
 * This is a confirmation gate, not a capability refusal: single-item writes and
 * ordinary commands never fire it, and the planner re-issues the same command
 * with confirm=true after the user says yes. Classification is on the command
 * string itself (ground truth), never on conversational text.
 */

export interface DestructiveVerdict {
  destructive: boolean;
  /** Human-readable reason, e.g. "recursive delete". */
  reason?: string;
  /** The specific targets (paths/db names) the operation would destroy. */
  targets: string[];
}

const RECURSIVE_RM_FLAG = /^-[a-z]*[rR][a-z]*$/;
const FORCE_ONLY_FLAG = /^-[a-z]*f[a-z]*$/;

// GNU getopt accepts an unambiguous long-option prefix, so `--rec` and `--f`
// have the same effect as their complete spellings.
function isLongOption(arg: string, option: string): boolean {
  return arg.length > 2 && option.startsWith(arg);
}

function isRecursiveRmFlag(arg: string): boolean {
  return isLongOption(arg, "--recursive") || RECURSIVE_RM_FLAG.test(arg);
}
function isForceRmFlag(arg: string): boolean {
  return isLongOption(arg, "--force") || FORCE_ONLY_FLAG.test(arg);
}

function parseRmArguments(rest: readonly string[]): {
  force: boolean;
  paths: string[];
  recursive: boolean;
} {
  let force = false;
  let parsingOptions = true;
  let recursive = false;
  const paths: string[] = [];

  for (const arg of rest) {
    if (parsingOptions && arg === "--") {
      parsingOptions = false;
    } else if (parsingOptions && isRecursiveRmFlag(arg)) {
      recursive = true;
    } else if (parsingOptions && isForceRmFlag(arg)) {
      force = true;
    } else if (!parsingOptions || !arg.startsWith("-")) {
      paths.push(arg);
    }
  }

  return { force, paths, recursive };
}
const POWERSHELL_RECURSE_FLAG = /^-(?:r|re|rec|recu|recur|recurs|recurse)$/i;
const POWERSHELL_REMOVE_ITEM_BINS = new Set([
  "remove-item",
  "del",
  "erase",
  "rd",
  "ri",
  "rmdir",
]);
const DESTRUCTIVE_BINS = new Set(["mkfs", "shred", "wipefs"]);
const DROP_SQL = /\bdrop\s+(database|table|schema)\s+(\S+)/i;

interface HeredocDeclaration {
  delimiter: string;
  stripTabs: boolean;
}

function parseHeredocDelimiter(line: string, start: number): string | null {
  let cursor = start;
  let delimiter = "";
  let quote: string | null = null;

  while (cursor < line.length) {
    const ch = line[cursor] as string;
    if (quote) {
      if (ch === quote) {
        quote = null;
        cursor += 1;
        continue;
      }
      if (
        quote === '"' &&
        ch === "\\" &&
        cursor + 1 < line.length &&
        /[$`"\\]/.test(line[cursor + 1] as string)
      ) {
        cursor += 1;
      }
      delimiter += line[cursor] as string;
      cursor += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cursor += 1;
      continue;
    }
    if (ch === "\\" && cursor + 1 < line.length) {
      cursor += 1;
      delimiter += line[cursor] as string;
      cursor += 1;
      continue;
    }
    if (/[\s|;&<>()]/.test(ch)) break;
    delimiter += ch;
    cursor += 1;
  }

  return quote === null && delimiter ? delimiter : null;
}

function heredocDeclarations(line: string): HeredocDeclaration[] {
  const declarations: HeredocDeclaration[] = [];
  let arithmeticDepth = 0;
  let quote: string | null = null;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] as string;
    if (quote) {
      if (quote === '"' && ch === "\\" && i + 1 < line.length) i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\" && i + 1 < line.length) {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(" && line[i + 1] === "(") {
      arithmeticDepth += 1;
      i += 1;
      continue;
    }
    if (arithmeticDepth > 0 && ch === ")" && line[i + 1] === ")") {
      arithmeticDepth -= 1;
      i += 1;
      continue;
    }
    if (arithmeticDepth > 0) continue;
    if (ch === "#" && (i === 0 || /[\s;|&()]/.test(line[i - 1] as string)))
      break;
    if (ch !== "<" || line[i + 1] !== "<" || line[i + 2] === "<") continue;

    let cursor = i + 2;
    const stripTabs = line[cursor] === "-";
    if (stripTabs) cursor += 1;
    while (line[cursor] === " " || line[cursor] === "\t") cursor += 1;

    const delimiter = parseHeredocDelimiter(line, cursor);
    if (delimiter !== null) declarations.push({ delimiter, stripTabs });
  }
  return declarations;
}

// Heredoc bodies are shell input, not commands. Preserve their newlines so
// later executable lines remain segment boundaries, but hide payload bytes
// from both the command and SQL classifiers.
function maskHeredocBodies(command: string): string {
  const lines = command.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? [];
  const pending: HeredocDeclaration[] = [];

  return lines
    .map((line) => {
      const newline = line.endsWith("\r\n")
        ? "\r\n"
        : line.endsWith("\n")
          ? "\n"
          : line.endsWith("\r")
            ? "\r"
            : "";
      const content = newline ? line.slice(0, -newline.length) : line;
      const active = pending[0];
      if (active) {
        const comparable = active.stripTabs
          ? content.replace(/^\t+/, "")
          : content;
        if (comparable === active.delimiter) pending.shift();
        return `${" ".repeat(content.length)}${newline}`;
      }
      pending.push(...heredocDeclarations(content));
      return line;
    })
    .join("");
}

function splitSegments(command: string): string[] {
  // Split shell list/pipeline operators while retaining quoted or backslash-
  // escaped characters in their current segment.
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] as string;
    if (quote) {
      current += ch;
      if (quote === '"' && ch === "\\" && i + 1 < command.length) {
        current += command[i + 1] as string;
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += ch;
      current += command[i + 1] as string;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "&" || ch === "\n" || ch === "\r") {
      segments.push(current);
      current = "";
      if (ch === "&" && command[i + 1] === "&") i += 1;
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter(Boolean);
}

function tokens(segment: string): string[] {
  return segment.split(/\s+/).filter(Boolean);
}

export function classifyDestructiveCommand(
  command: string,
): DestructiveVerdict {
  const executableCommand = maskHeredocBodies(command);
  const sql = DROP_SQL.exec(executableCommand);
  if (sql) {
    return {
      destructive: true,
      reason: `drops ${sql[1]?.toLowerCase()}`,
      targets: [sql[2] ?? ""],
    };
  }
  for (const segment of splitSegments(executableCommand)) {
    const argv = tokens(segment);
    // env-var prefixes (FOO=bar cmd …) precede the executable
    let i = 0;
    while (
      i < argv.length &&
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i] as string)
    )
      i += 1;
    const bin = (argv[i] ?? "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
    const rest = argv.slice(i + 1);

    if (bin === "rm") {
      const { force, paths, recursive } = parseRmArguments(rest);
      if (recursive) {
        return {
          destructive: true,
          reason: "recursive delete",
          targets: paths,
        };
      }
      // rm -f on a glob is bulk too; single explicit path is not.
      if (force && paths.some((p) => p.includes("*"))) {
        return {
          destructive: true,
          reason: "forced glob delete",
          targets: paths,
        };
      }
    }
    if (POWERSHELL_REMOVE_ITEM_BINS.has(bin)) {
      const recursive = rest.some((arg) => POWERSHELL_RECURSE_FLAG.test(arg));
      if (recursive) {
        return {
          destructive: true,
          reason: "recursive delete",
          targets: rest.filter((arg) => !arg.startsWith("-")),
        };
      }
    }
    if (
      bin === "find" &&
      (rest.includes("-delete") || rest.join(" ").includes("-exec rm"))
    ) {
      return {
        destructive: true,
        reason: "bulk find-delete",
        targets: rest.filter((a) => !a.startsWith("-")).slice(0, 3),
      };
    }
    if (bin === "dd") {
      const of = rest.find((a) => a.startsWith("of=/dev/"));
      if (of) {
        return {
          destructive: true,
          reason: "raw device overwrite",
          targets: [of],
        };
      }
    }
    if (DESTRUCTIVE_BINS.has(bin) || bin.startsWith("mkfs.")) {
      return {
        destructive: true,
        reason: `${bin} destroys its target`,
        targets: rest.filter((a) => !a.startsWith("-")),
      };
    }
  }
  return { destructive: false, targets: [] };
}

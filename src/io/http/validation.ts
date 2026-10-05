import type { ZodError } from 'zod';

export interface FieldProblem {
  path: string;
  code: string;
}

/** Messages written as stable keys (such as "tooLong") pass through; zod's own sentences become "invalid". */
const STABLE_KEY = /^[a-z][A-Za-z]{1,30}$/;

/** What is safe to tell the client about a rejected body: which fields, and a code for each. Never the values. */
export function fieldProblems(error: ZodError): FieldProblem[] {
  const seen = new Set<string>();
  const problems: FieldProblem[] = [];
  for (const issue of error.issues) {
    const path = issue.path.join('.');
    const code = STABLE_KEY.test(issue.message) ? issue.message : 'invalid';
    if (seen.has(`${path}|${code}`)) continue;
    seen.add(`${path}|${code}`);
    problems.push({ path, code });
  }
  return problems;
}

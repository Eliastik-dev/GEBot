import { evaluateResponse, type JudgeInput } from "../judge.js";
import { fireAndForget } from "../utils/async.js";

export function scheduleJudgeEvaluation(input: JudgeInput): void {
  fireAndForget(evaluateResponse(input), "judge.evaluate");
}

export type { JudgeInput };

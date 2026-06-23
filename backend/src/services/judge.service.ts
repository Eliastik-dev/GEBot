import { evaluateResponse, type JudgeInput } from "../modules/feedback/judge.js";
import { fireAndForget } from "../utils/async.js";

export function scheduleJudgeEvaluation(input: JudgeInput): void {
  fireAndForget(evaluateResponse(input), "judge.evaluate");
}

export type { JudgeInput };

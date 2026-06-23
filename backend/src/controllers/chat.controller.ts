import type { Request, Response } from "express";
import { executeChatTurn, type ChatDeps } from "../modules/chat/execute-chat-turn.js";
export type { ChatDeps };
export async function postChat(req: Request, res: Response, deps: ChatDeps) {
  await executeChatTurn(req, res, deps);
}

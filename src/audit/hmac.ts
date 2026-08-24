import { getEnv } from "../env.js"
import { verifyRootsyAiExecutionHeader } from "./hmacCore.js"

const HEADER = "x-rootsy-execution"

export function verifyRootsyAiExecution(input: {
  header: string | undefined
  userId: string
  popId: string
  method: string
  path: string
}): boolean {
  return verifyRootsyAiExecutionHeader({
    header: input.header,
    secret: getEnv().ROOTSY_AI_EXECUTION_SECRET,
    userId: input.userId,
    popId: input.popId,
    method: input.method,
    path: input.path,
  })
}

export { HEADER as ROOTSY_AI_EXECUTION_HEADER }
export { signRootsyAiExecution } from "./hmacCore.js"

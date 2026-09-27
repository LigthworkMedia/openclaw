import {
  claimCronRunReceiptInDatabase,
  claimLocalCronRunReceiptOwnership,
} from "./run-receipt-store.js";

export function claimCronRunReceiptForTest(
  params: Parameters<typeof claimCronRunReceiptInDatabase>[0],
) {
  const handle = claimCronRunReceiptInDatabase(params);
  claimLocalCronRunReceiptOwnership(handle);
  return handle;
}

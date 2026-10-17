import { useEffect, useMemo, useState } from "react";
import { useCorePlanApproval } from "../core-screens/coreApi.js";
import { withCorePlanApproval } from "./planApproval.js";
import { readWorkRecords, subscribeWorkRecords } from "./projectWorkRecords.js";

/**
 * Live view of one project's work records; re-reads on any section write. The
 * core ledger's plan approval is attached as `corePlan` (see planApproval.js),
 * so every screen reading these records shows the same plan approval.
 */
export function useProjectWorkRecords(projectId, storage) {
  const [records, setRecords] = useState(() => readWorkRecords(projectId, storage));
  useEffect(() => {
    setRecords(readWorkRecords(projectId, storage));
    return subscribeWorkRecords(projectId, () => setRecords(readWorkRecords(projectId, storage)));
  }, [projectId, storage]);
  const corePlan = useCorePlanApproval(projectId);
  return useMemo(() => withCorePlanApproval(records, corePlan), [records, corePlan]);
}

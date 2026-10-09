import { useEffect, useState } from "react";
import { readWorkRecords, subscribeWorkRecords } from "./projectWorkRecords.js";

/** Live view of one project's work records; re-reads on any section write. */
export function useProjectWorkRecords(projectId, storage) {
  const [records, setRecords] = useState(() => readWorkRecords(projectId, storage));
  useEffect(() => {
    setRecords(readWorkRecords(projectId, storage));
    return subscribeWorkRecords(projectId, () => setRecords(readWorkRecords(projectId, storage)));
  }, [projectId, storage]);
  return records;
}

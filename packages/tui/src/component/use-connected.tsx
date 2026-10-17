import { createMemo } from "solid-js"
import { useData } from "../context/data"

export function useConnected() {
  const data = useData()
  return createMemo(() =>
    (data.location.integration.list() ?? []).some((integration) => integration.connections.length > 0),
  )
}

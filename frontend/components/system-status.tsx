/** Shared release-update state and the footer's accessible status indicator. */
"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { Row, StatusIndicator, Text } from "@once-ui-system/core";
import { getSystemStatus } from "@/lib/api";

const UpdateContext = createContext(false);
const POLL_INTERVAL = 5 * 60 * 1000;

export function SystemStatusProvider({ children }: { children: React.ReactNode }) {
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const check = async () => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const status = await getSystemStatus(controller.signal);
        if (!controller.signal.aborted && typeof status?.update_available === "boolean") {
          setUpdateAvailable(status.update_available);
        }
      } catch {
        // Update availability is advisory; retain the last known state on failure.
      } finally {
        pending = false;
      }
    };
    void check();
    const timer = window.setInterval(() => { void check(); }, POLL_INTERVAL);
    document.addEventListener("visibilitychange", check);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);

  return <UpdateContext.Provider value={updateAvailable}>{children}</UpdateContext.Provider>;
}

export function SystemStatus() {
  const updateAvailable = useContext(UpdateContext);
  const message = updateAvailable ? "update available" : "ready";

  return (
    <Row gap="4" vertical="center">
      <Text variant="body-default-xs" onBackground="neutral-weak">Systems Status</Text>
      <span
        className="system-status-trigger"
        role="img"
        tabIndex={0}
        title={message}
        aria-label={`Systems Status: ${message}`}
        data-status={updateAvailable ? "update-available" : "ready"}
      >
        <StatusIndicator size="m" color={updateAvailable ? "yellow" : "green"} aria-hidden="true" />
      </span>
    </Row>
  );
}

import { useEffect, useState } from "react";
import { mailAvailable } from "@/server/mailbox.functions";

/** Whether this person has the mail module (role and extension), asked once per page load. */
let asked: Promise<boolean> | null = null;

export function useMailAvailable(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    asked ??= mailAvailable()
      .then((answer) => answer.ready)
      .catch(() => false);
    let alive = true;
    void asked.then((value) => alive && setReady(value));
    return () => {
      alive = false;
    };
  }, []);
  return ready;
}

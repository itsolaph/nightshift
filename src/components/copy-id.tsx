"use client";

import { useState } from "react";

/** A PayPal id that copies itself on click, so judges can look it up in the sandbox. */
export function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <code
      className="pid"
      title="Copy id"
      onClick={() => {
        void navigator.clipboard?.writeText(id).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? "copied" : id}
    </code>
  );
}

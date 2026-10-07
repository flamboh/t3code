import { useMemo, type ComponentProps, type ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type DiagnosticsTooltipPayload = {
  tooltip: ReactNode;
  variant?: "default" | "code";
};

export function DiagnosticsTooltips({ children }: { children: ReactNode }) {
  return (
    <Tooltip<DiagnosticsTooltipPayload>>
      {({ payload }) => (
        <>
          {children}
          <TooltipPopup side="top" variant={payload?.variant ?? "default"}>
            {payload?.tooltip}
          </TooltipPopup>
        </>
      )}
    </Tooltip>
  );
}

export function DiagnosticsTooltip({
  tooltip,
  variant,
  ...props
}: ComponentProps<typeof TooltipTrigger> & DiagnosticsTooltipPayload) {
  const payload = useMemo(() => ({ tooltip, variant }), [tooltip, variant]);
  return <TooltipTrigger {...props} payload={payload} />;
}

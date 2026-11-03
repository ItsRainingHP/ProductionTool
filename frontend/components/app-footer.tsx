/**
 * @file Shared application footer with privacy and usage guidance.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

import { Column, Row, SmartLink, Text } from "@once-ui-system/core";
import { version } from "@/package.json";
import { SystemStatus } from "./system-status";

export function AppFooter() {
  return (
    <Row
      as="footer"
      fillWidth
      horizontal="center"
      background="surface"
      borderTop="neutral-alpha-weak"
      className="app-footer"
    >
      <Row
        fillWidth
        maxWidth="l"
        horizontal="between"
        vertical="center"
        paddingX="24"
        paddingY="20"
        gap="12"
        s={{ direction: "column", horizontal: "start", vertical: "start" }}
      >
        <Column gap="4">
          <Text variant="body-default-s" onBackground="neutral-weak">
            Created by Brent Coleman
          </Text>
          <Text variant="body-default-xs" onBackground="neutral-weak">
            Version {version}
          </Text>
          <SystemStatus />
        </Column>
        <Column gap="4" horizontal="end" s={{ horizontal: "start" }}>
          <SmartLink
            href="https://once-ui.com"
            target="_blank"
            rel="noopener noreferrer"
            unstyled
            aria-label="Visit the Once UI website"
          >
            <Text variant="body-default-s" onBackground="neutral-weak">
              Built with Once UI
            </Text>
          </SmartLink>
          <SmartLink
            href="https://github.com/ItsRainingHP/ProductionTool/blob/main/LICENSE"
            target="_blank"
            rel="noopener noreferrer"
            unstyled
            aria-label="View the Production Tool MIT license on GitHub"
          >
            <Text variant="body-default-xs" onBackground="neutral-weak">
              MIT License
            </Text>
          </SmartLink>
        </Column>
      </Row>
    </Row>
  );
}

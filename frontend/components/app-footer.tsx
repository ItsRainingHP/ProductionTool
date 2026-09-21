/**
 * @file Shared application footer with privacy and usage guidance.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

import { Row, SmartLink, Text } from "@once-ui-system/core";

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
        <Text variant="body-default-s" onBackground="neutral-weak">
          Created by Brent Coleman
        </Text>
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
      </Row>
    </Row>
  );
}

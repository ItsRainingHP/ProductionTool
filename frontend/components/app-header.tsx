/**
 * @file Shared application header, home link, and theme switcher.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

"use client";

import { Column, Heading, Row, SmartLink, Text, ThemeSwitcher } from "@once-ui-system/core";

export function AppHeader() {
  return (
    <Column
      as="header"
      fillWidth
      horizontal="center"
      background="surface"
      borderBottom="neutral-alpha-weak"
      className="app-header"
    >
      <Row fillWidth maxWidth="l" horizontal="between" vertical="center" paddingX="24" paddingY="16">
        <SmartLink href="/" unstyled>
          <Row gap="12" vertical="center">
            <Row center width="40" height="40" radius="m" background="brand-alpha-weak" border="brand-alpha-medium">
              <Text variant="heading-strong-s" onBackground="brand-strong">P</Text>
            </Row>
            <Column gap="0">
              <Heading as="span" variant="heading-strong-s">Production Tool</Heading>
              <Text variant="label-default-xs" onBackground="neutral-weak">Discovery CSV workspace</Text>
            </Column>
          </Row>
        </SmartLink>
        <ThemeSwitcher />
      </Row>
    </Column>
  );
}

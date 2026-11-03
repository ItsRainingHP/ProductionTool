import { Row, Text } from "@once-ui-system/core";

/** Shared theme-aware treatment for the header's initial and Help symbol. */
export function HeaderSymbol({ children }: { children: React.ReactNode }) {
  return <Row center width="40" height="40" radius="m" background="brand-alpha-weak" border="brand-alpha-medium">
    <Text variant="heading-strong-s" onBackground="brand-strong">{children}</Text>
  </Row>;
}

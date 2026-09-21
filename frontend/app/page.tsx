/**
 * @file Production Tool landing page and feature overview.
 * @author Brent Coleman
 * @copyright 2026 Brent Coleman
 * @license MIT
 */

import { Background, Button, Column, Grid, Heading, Icon, RevealFx, Row, Text } from "@once-ui-system/core";
import { AppFooter } from "@/components/app-footer";
import { AppHeader } from "@/components/app-header";

const features = [
  { icon: "document" as const, title: "RFP ranges", text: "Collapse Bates data into accurate contiguous ranges while preserving every gap." },
  { icon: "chevronsLeftRight" as const, title: "Privilege mapping", text: "Shape source fields into a clean, reviewable privilege log without spreadsheets." },
  { icon: "check" as const, title: "Built-in validation", text: "Catch malformed CSV and Bates issues before anything is downloaded." },
];

export default function Home() {
  return (
    <Column fill minHeight="100vh">
      <AppHeader />
      <Column as="main" fillWidth horizontal="center" paddingX="24" paddingY="80" overflow="hidden">
        <Background
          position="absolute"
          top="0"
          left="0"
          fill
          pointerEvents="none"
          gradient={{ display: true, colorStart: "brand-alpha-medium", colorEnd: "static-transparent", x: 50, y: 0, width: 170, height: 75, opacity: 60 }}
          dots={{ display: true, color: "neutral-alpha-weak", size: "2", opacity: 40 }}
        />
        <Column zIndex={1} fillWidth maxWidth="l" gap="64" horizontal="center">
          <Column horizontal="center" gap="24" maxWidth={52}>
            <RevealFx translateY="16">
              <Column horizontal="center" gap="16">
                <Text variant="label-default-s" onBackground="brand-medium">PRIVATE PRODUCTION WORKSPACE</Text>
                <Heading as="h1" variant="display-strong-l" align="center">
                  Turn discovery exports into production-ready pleading ranges and privilege logs.
                </Heading>
              </Column>
            </RevealFx>
            <RevealFx delay={0.1} translateY="16">
              <Text variant="body-default-l" onBackground="neutral-weak" align="center">
                Upload a supported CSV export, validate its structure, configure the output, and review the result before download.
              </Text>
            </RevealFx>
            <Button href="/wizard" size="l" arrowIcon>Start Processing</Button>
          </Column>
          <Grid columns="3" gap="16" fillWidth s={{ columns: 1 }}>
            {features.map((feature) => (
              <Column key={feature.title} background="surface" border="neutral-alpha-weak" radius="l" padding="24" gap="16">
                <Row center width="40" height="40" radius="m" background="brand-alpha-weak">
                  <Icon name={feature.icon} size="s" onBackground="brand-medium" />
                </Row>
                <Heading as="h2" variant="heading-strong-m">{feature.title}</Heading>
                <Text variant="body-default-s" onBackground="neutral-weak">{feature.text}</Text>
              </Column>
            ))}
          </Grid>
        </Column>
      </Column>
      <AppFooter />
    </Column>
  );
}

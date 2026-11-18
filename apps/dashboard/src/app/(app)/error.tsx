"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <Card className="max-w-lg">
      <CardHeader>
        <CardTitle>This page could not load</CardTitle>
        <CardDescription>
          The dashboard could not get an answer from the gateway. Check that the gateway is running.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="outline" onClick={reset}>
          Try again
        </Button>
      </CardContent>
    </Card>
  );
}

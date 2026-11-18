import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type Props = HTMLAttributes<HTMLDivElement>;

export function Card({ className, ...props }: Props) {
  return (
    <div className={cn("min-w-0 rounded-lg border border-border bg-card", className)} {...props} />
  );
}

export function CardHeader({ className, ...props }: Props) {
  return (
    <div className={cn("flex flex-col gap-1 p-4 pb-2 sm:p-5 sm:pb-2", className)} {...props} />
  );
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("text-sm font-semibold", className)} {...props} />;
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-secondary", className)} {...props} />;
}

export function CardContent({ className, ...props }: Props) {
  return <div className={cn("p-4 pt-2 sm:p-5 sm:pt-2", className)} {...props} />;
}

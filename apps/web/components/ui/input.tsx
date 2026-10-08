import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "../../lib/utils.js"

// Suplex fields hold app data, not identities. Password managers and browser
// autofill stay out unless a field is a password or names its autofill purpose.
const unmanaged = { autoComplete: "off", "data-1p-ignore": true, "data-lpignore": "true", "data-bwignore": true, "data-form-type": "other" }

function Input({ className, type, size = "default", ...props }: Omit<React.ComponentProps<"input">, "size"> & { size?: "sm" | "default" }) {
  const managed = type === "password" || (props.autoComplete !== undefined && props.autoComplete !== "off")
  return (
    <InputPrimitive
      {...(managed ? {} : unmanaged)}
      type={type}
      data-slot="input"
      data-size={size}
      className={cn(
        "w-full min-w-0 rounded-control border border-input bg-transparent px-2.5 py-1 shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-foreground/25 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[size=default]:h-9 data-[size=default]:text-base data-[size=default]:md:text-sm data-[size=sm]:h-8 data-[size=sm]:text-base data-[size=sm]:sm:text-sm dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }

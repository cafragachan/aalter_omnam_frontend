import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-semibold tracking-tight transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive backdrop-blur-md",
  {
    variants: {
      variant: {
        default:
          'border border-white/70 bg-white/90 text-slate-900 shadow-[0_12px_30px_-18px_rgba(0,0,0,0.6)] hover:bg-white/100',
        destructive:
          'border border-white/50 bg-destructive text-white shadow-[0_10px_30px_-16px_rgba(220,38,38,0.45)] hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60',
        outline:
          'border border-white/70 bg-white/20 text-slate-900 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)] hover:bg-white/35',
        secondary:
          'border border-white/50 bg-white/20 text-slate-900 hover:bg-white/35',
        ghost:
          'text-white hover:bg-white/10 hover:text-white',
        link: 'text-white/80 underline-offset-4 hover:text-white hover:underline',
      },
      size: {
        default: 'h-11 px-5 has-[>svg]:px-4',
        sm: 'h-9 gap-1.5 px-4 has-[>svg]:px-3',
        lg: 'h-12 px-6 text-base has-[>svg]:px-5',
        icon: 'size-10',
        'icon-sm': 'size-9',
        'icon-lg': 'size-11',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : 'button'

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }

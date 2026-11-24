import React from 'react';

/** Every page's frame: one title, one sentence, optional actions. */
export default function PageContainer({
  children,
  pageTitle,
  pageDescription,
  pageHeaderAction
}: {
  children: React.ReactNode;
  pageTitle: string;
  pageDescription?: string;
  pageHeaderAction?: React.ReactNode;
}) {
  return (
    <div className='mx-auto flex w-full max-w-7xl min-w-0 flex-1 flex-col p-4 md:p-6'>
      <div className='mb-6 flex flex-wrap items-start justify-between gap-x-4 gap-y-3'>
        <div className='min-w-0'>
          <h1 className='text-xl font-semibold tracking-tight text-balance md:text-2xl'>{pageTitle}</h1>
          {pageDescription && (
            <p className='text-muted-foreground mt-1 max-w-3xl text-sm text-pretty'>{pageDescription}</p>
          )}
        </div>
        {pageHeaderAction && <div className='flex flex-wrap gap-2'>{pageHeaderAction}</div>}
      </div>
      <div className='flex min-w-0 flex-col gap-6'>{children}</div>
    </div>
  );
}

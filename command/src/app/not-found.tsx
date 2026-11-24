import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className='flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center'>
      <p className='text-muted-foreground text-sm'>404</p>
      <h2 className='text-xl font-semibold'>No such page in the command center.</h2>
      <Button variant='outline' render={<Link href='/' />}>Back to overview</Button>
    </div>
  );
}

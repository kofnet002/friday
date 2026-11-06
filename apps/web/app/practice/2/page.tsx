import type { Metadata } from 'next';

import { PracticeApp } from '../practice-app';
import { PRACTICE_TESTS } from '../tests';

const { info } = PRACTICE_TESTS['2'];

// Neutral tab title, like /practice: no "Friday" anywhere on screen.
export const metadata: Metadata = {
  title: `${info.company} — Online Assessment | ${info.platform}`,
};

export default function PracticeTwoPage() {
  return <PracticeApp testId="2" />;
}

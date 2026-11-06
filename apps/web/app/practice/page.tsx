import type { Metadata } from 'next';

import { PracticeApp } from './practice-app';
import { PRACTICE_TESTS } from './tests';

const { info } = PRACTICE_TESTS['1'];

// A neutral tab title: this page plays the part of a third-party assessment
// site, so it should not say "Friday" anywhere a screen reader would see it.
export const metadata: Metadata = {
  title: `${info.company} — Online Assessment | ${info.platform}`,
};

export default function PracticePage() {
  return <PracticeApp testId="1" />;
}

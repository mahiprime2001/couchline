import { create } from 'zustand';

/**
 * What the host's page is doing to get a link ready ("Loading from the internet: 35%"). The host's page writes
 * it (HostedUpload), and the player shows it on the picture while a link loads. Null means nothing to say.
 */
export const useLinkStatus = create<{ text: string | null }>(() => ({ text: null }));

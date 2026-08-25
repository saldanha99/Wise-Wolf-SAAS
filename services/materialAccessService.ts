import { supabase } from '../lib/supabase';
import { parseMaterialStorageUrl } from '../lib/materialStorageUrl';

export const resolveMaterialAccessUrl = async (fileUrl: string): Promise<string> => {
  const { normalizedUrl, objectPath } = parseMaterialStorageUrl(fileUrl);
  if (!objectPath) return normalizedUrl;

  const { data, error } = await supabase.storage
    .from('materials')
    .createSignedUrl(objectPath, 120);
  if (error || !data?.signedUrl) {
    throw new Error(error?.message || 'MATERIAL_ACCESS_DENIED');
  }

  return data.signedUrl;
};

export const openMaterialAccess = async (fileUrl: string): Promise<void> => {
  const popup = window.open('about:blank', '_blank');
  if (popup) popup.opener = null;

  try {
    const accessUrl = await resolveMaterialAccessUrl(fileUrl);
    if (popup) {
      popup.location.replace(accessUrl);
      return;
    }
    window.open(accessUrl, '_blank', 'noopener,noreferrer');
  } catch (error) {
    popup?.close();
    throw error;
  }
};

import { useCallback } from 'react';

import { api } from '~/utils/api';

export const useInvalidateExpenseQueries = () => {
  const utils = api.useUtils();

  return useCallback(async () => {
    await Promise.all([
      utils.expense.invalidate(),
      utils.user.invalidate(),
      utils.group.invalidate(),
    ]);
  }, [utils]);
};

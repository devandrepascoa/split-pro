import { SplitType, type User } from '~/server/db/types';
import { ArrowRightIcon } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useInvalidateExpenseQueries } from '~/hooks/useInvalidateExpenseQueries';
import { DEFAULT_CATEGORY } from '~/lib/category';
import { api } from '~/utils/api';
import { BigMath } from '~/utils/numbers';

import { useSession } from '~/lib/auth-client';
import { useTranslationWithUtils } from '~/hooks/useTranslationWithUtils';
import type { MinimalBalance } from '~/types/balance.types';
import { EntityAvatar } from '../ui/avatar';
import { Button } from '../ui/button';
import { CurrencyInput } from '../ui/currency-input';
import { AppDrawer } from '../ui/drawer';
import { FriendBalance } from './FriendBalance';

export const SettleUp: React.FC<
  React.PropsWithChildren<{
    balances?: MinimalBalance[];
    friend: User;
  }>
> = ({ children, balances, friend }) => {
  const { t, displayName, getCurrencyHelpersCached } = useTranslationWithUtils();
  const { data } = useSession();
  const currentUser = data?.user;
  const invalidateExpenseQueries = useInvalidateExpenseQueries();
  const availableBalances = balances ?? [];

  const [balanceToSettle, setBalanceToSettle] = useState<MinimalBalance | undefined>(
    1 === availableBalances.length ? availableBalances[0] : undefined,
  );
  const [amount, setAmount] = useState<bigint>(
    1 === availableBalances.length ? BigMath.abs(availableBalances[0]?.amount ?? 0n) : 0n,
  );
  const [amountStr, setAmountStr] = useState<string>(
    getCurrencyHelpersCached(balanceToSettle?.currency ?? '').toUIString(amount),
  );

  useEffect(() => {
    const nextBalance = 1 === balances?.length ? balances[0] : undefined;
    const nextAmount = BigMath.abs(nextBalance?.amount ?? 0n);
    setBalanceToSettle(nextBalance);
    setAmount(nextAmount);
    setAmountStr(getCurrencyHelpersCached(nextBalance?.currency ?? '').toUIString(nextAmount));
  }, [balances, getCurrencyHelpersCached]);

  const isCurrentUserPaying = 0 > (balanceToSettle?.amount ?? 0);

  function onSelectBalance(balance: MinimalBalance) {
    setBalanceToSettle(balance);
    setAmount(BigMath.abs(balance.amount));
    setAmountStr(
      getCurrencyHelpersCached(balance.currency).toUIString(BigMath.abs(balance.amount)),
    );
  }

  const addExpenseMutation = api.expense.addOrEditExpense.useMutation();

  const saveExpense = React.useCallback(() => {
    if (!balanceToSettle || !amount || !currentUser) {
      return;
    }

    addExpenseMutation.mutate(
      {
        name: t('ui.settle_up_name'),
        currency: balanceToSettle.currency,
        amount,
        splitType: SplitType.SETTLEMENT,
        participants: [
          {
            userId: currentUser.id,
            amount: isCurrentUserPaying ? amount : -amount,
          },
          {
            userId: friend.id,
            amount: isCurrentUserPaying ? -amount : amount,
          },
        ],
        paidBy: isCurrentUserPaying ? currentUser.id : friend.id,
        category: DEFAULT_CATEGORY,
        groupId: balanceToSettle.groupId,
      },
      {
        onSuccess: async () => {
          await invalidateExpenseQueries();
        },
        onError: (error) => {
          console.error('Error while saving expense:', error);
          toast.error(t('errors.saving_expense'));
        },
      },
    );
  }, [
    balanceToSettle,
    amount,
    currentUser,
    isCurrentUserPaying,
    friend,
    addExpenseMutation,
    invalidateExpenseQueries,
    t,
  ]);

  const onCurrencyInputValueChange = React.useCallback(
    ({ strValue, bigIntValue }: { strValue?: string; bigIntValue?: bigint }) => {
      if (strValue !== undefined) {
        setAmountStr(strValue);
      }
      if (bigIntValue !== undefined) {
        setAmount(bigIntValue);
      }
    },
    [],
  );

  const onBackClick = React.useCallback(() => {
    if (balanceToSettle) {
      setBalanceToSettle(undefined);
    }
  }, [balanceToSettle]);

  if (!currentUser) {
    return null;
  }

  if (!balances) {
    return (
      <Button size="sm" variant="outline" responsiveIcon disabled>
        <span className="xs:inline hidden">{t('actions.settle_up')}</span>
      </Button>
    );
  }

  return (
    <AppDrawer
      trigger={children}
      disableTrigger={!balances?.length}
      leftAction={t('actions.back')}
      leftActionOnClick={onBackClick}
      shouldCloseOnLeftAction={false}
      title={balanceToSettle ? t('ui.settle_up_name') : t('ui.select_balance')}
      className="h-[70vh]"
      actionTitle={t('actions.save')}
      actionDisabled={!balanceToSettle || !amount}
      actionOnClick={saveExpense}
      shouldCloseOnAction
    >
      {!balanceToSettle ? (
        <div>
          {availableBalances.map((b) => (
            <div
              key={`${b.friendId}-${b.currency}-${b.groupId ?? 'null'}`}
              onClick={() => onSelectBalance(b)}
              className="cursor-pointer px-4 py-2"
            >
              <FriendBalance user={friend} balance={b} groupName={b.groupName} />
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-10 flex flex-col items-center gap-6">
          <div className="flex flex-col items-center">
            <div className="flex items-center gap-5">
              <EntityAvatar entity={isCurrentUserPaying ? currentUser : friend} />
              <ArrowRightIcon className="h-6 w-6 text-gray-600" />
              <EntityAvatar entity={isCurrentUserPaying ? friend : currentUser} />
            </div>
            <p className="mt-2 text-center text-sm text-gray-400">
              {isCurrentUserPaying
                ? `${t('actors.you')} ${t('ui.expense.you.pay')} ${displayName(friend)}`
                : `${displayName(friend)} ${t('ui.expense.user.pay')} ${t('actors.you')}`}
            </p>
            {balanceToSettle.groupName ? (
              <p className="mt-1 text-center text-xs text-gray-500">{balanceToSettle.groupName}</p>
            ) : null}
          </div>
          <CurrencyInput
            currency={balanceToSettle.currency}
            strValue={amountStr}
            className="mx-auto mt-4 w-[150px] text-center text-lg"
            onValueChange={onCurrencyInputValueChange}
          />
        </div>
      )}
    </AppDrawer>
  );
};

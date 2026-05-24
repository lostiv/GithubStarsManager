import { createContext, useContext } from 'react';
import type { ToastType } from '../components/ui/Toast';

export interface ToastState {
  message: string;
  type: ToastType;
  key: number;
}

export interface ConfirmState {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  type?: 'danger' | 'warning' | 'info';
}

export interface DialogContextValue {
  toast: (message: string, type?: ToastType) => void;
  confirm: (title: string, message: string, options?: {
    confirmText?: string;
    cancelText?: string;
    type?: 'danger' | 'warning' | 'info';
  }) => Promise<boolean>;
}

export const DialogContext = createContext<DialogContextValue | null>(null);

export const useDialog = (): DialogContextValue => {
  const context = useContext(DialogContext);
  if (!context) {
    throw new Error('useDialog must be used within a DialogProvider');
  }
  return context;
};

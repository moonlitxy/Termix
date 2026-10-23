import { create } from "zustand";

export type ToastTone = "info" | "success" | "warning" | "error";

export interface ToastOptions {
  title?: string;
  message: string;
  tone?: ToastTone;
  duration?: number;
}

export interface ToastItem extends Required<Omit<ToastOptions, "title">> {
  id: number;
  title?: string;
}

interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

interface PromptOptions {
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
}

interface ConfirmRequest extends ConfirmOptions {
  id: number;
  resolve: (confirmed: boolean) => void;
}

interface PromptRequest extends PromptOptions {
  id: number;
  resolve: (value: string | null) => void;
}

interface FeedbackState {
  toasts: ToastItem[];
  confirmRequest: ConfirmRequest | null;
  promptRequest: PromptRequest | null;
  pushToast: (options: ToastOptions) => number;
  dismissToast: (id: number) => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
  settleConfirm: (confirmed: boolean) => void;
  settlePrompt: (value: string | null) => void;
}

let sequence = 0;
const DEFAULT_DURATION = 3200;
const MAX_TOASTS = 4;

export const useFeedback = create<FeedbackState>((set, get) => ({
  toasts: [],
  confirmRequest: null,
  promptRequest: null,

  pushToast: ({ title, message, tone = "info", duration }) => {
    const id = ++sequence;
    const toast: ToastItem = {
      id,
      title,
      message,
      tone,
      duration: duration ?? (tone === "error" ? 5200 : DEFAULT_DURATION),
    };
    set((state) => ({
      toasts: [...state.toasts, toast].slice(-MAX_TOASTS),
    }));
    if (toast.duration > 0) {
      window.setTimeout(() => get().dismissToast(id), toast.duration);
    }
    return id;
  },

  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),

  confirm: (options) => {
    get().promptRequest?.resolve(null);
    get().confirmRequest?.resolve(false);
    return new Promise<boolean>((resolve) => {
      set({
        promptRequest: null,
        confirmRequest: { ...options, id: ++sequence, resolve },
      });
    });
  },

  prompt: (options) => {
    get().confirmRequest?.resolve(false);
    get().promptRequest?.resolve(null);
    return new Promise<string | null>((resolve) => {
      set({
        confirmRequest: null,
        promptRequest: { ...options, id: ++sequence, resolve },
      });
    });
  },

  settleConfirm: (confirmed) => {
    const request = get().confirmRequest;
    if (!request) return;
    set({ confirmRequest: null });
    request.resolve(confirmed);
  },

  settlePrompt: (value) => {
    const request = get().promptRequest;
    if (!request) return;
    set({ promptRequest: null });
    request.resolve(value);
  },
}));

function showToast(
  tone: ToastTone,
  message: string,
  title?: string,
  duration?: number
) {
  return useFeedback.getState().pushToast({ tone, message, title, duration });
}

export const toast = {
  info: (message: string, title?: string) => showToast("info", message, title),
  success: (message: string, title?: string) => showToast("success", message, title),
  warning: (message: string, title?: string) => showToast("warning", message, title),
  error: (message: string, title?: string) => showToast("error", message, title),
};

export const confirmDialog = (options: ConfirmOptions) =>
  useFeedback.getState().confirm(options);

export const promptDialog = (options: PromptOptions) =>
  useFeedback.getState().prompt(options);

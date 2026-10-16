import { api } from "@managealltv/protocol";

export interface PasswordProblems {
  password?: string;
  repeat?: string;
}

/** Same rule the server applies (api.Password: 12–128 characters), plus the repeat check. */
export function passwordProblems(password: string, repeat: string): PasswordProblems {
  const problems: PasswordProblems = {};
  if (!api.Password.safeParse(password).success) {
    problems.password = password.length > 128 ? "En fazla 128 karakter olabilir." : "En az 12 karakter olmalı.";
  }
  if (repeat !== password) problems.repeat = "Parolalar aynı değil.";
  return problems;
}

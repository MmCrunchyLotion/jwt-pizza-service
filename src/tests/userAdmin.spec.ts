import { test, expect } from "playwright-test-coverage";
import type { Page } from "@playwright/test";

async function register(page: Page, name: string, email: string, password: string) {
  await page.goto("/");
  await page.getByRole("link", { name: "Register" }).click();
  await page.getByRole("textbox", { name: "Full name" }).fill(name);
  await page.getByRole("textbox", { name: "Email address" }).fill(email);
  await page.getByRole("textbox", { name: "Password" }).fill(password);
  await page.getByRole("button", { name: "Register" }).click();
}

async function login(page: Page, email: string, password: string) {
  await page.getByRole("link", { name: "Login" }).click();
  await page.getByRole("textbox", { name: "Email address" }).fill(email);
  await page.getByRole("textbox", { name: "Password" }).fill(password);
  await page.getByRole("button", { name: "Login" }).click();
}

async function logout(page: Page) {
  await page.getByRole("link", { name: "Logout" }).click();
}

async function filterUsers(page: Page, text: string) {
  await page.getByPlaceholder("Filter users").fill(text);
  await page.getByRole("button", { name: "Search users" }).click();
}

test("admin can list, filter and delete a user", async ({ page }) => {
  const suffix = Math.floor(Math.random() * 100000);
  const name = `victim ${suffix}`;
  const email = `victim${suffix}@jwt.com`;
  const password = "victim";

  // create a user, then switch to the default admin
  await register(page, name, email, password);
  await logout(page);
  await login(page, "a@jwt.com", "admin");
  await page.getByRole("link", { name: "Admin" }).click();

  // list shows name, email and role, and can be filtered by name
  await filterUsers(page, name);
  const row = page.locator("tr", { hasText: email });
  await expect(row).toBeVisible();
  await expect(row).toContainText(name);
  await expect(row).toContainText("diner");

  // cancelling keeps the user
  await row.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Are you sure you want to delete the user")).toContainText(name);
  await page.getByRole("button", { name: "Cancel" }).click();
  await filterUsers(page, name);
  await expect(page.locator("tr", { hasText: email })).toBeVisible();

  // confirming removes the user
  await page.locator("tr", { hasText: email }).getByRole("button", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await filterUsers(page, name);
  await expect(page.locator("tr", { hasText: email })).toHaveCount(0);

  // the deleted user can no longer log in
  await logout(page);
  await login(page, email, password);
  await expect(page.getByText("unknown user")).toBeVisible();
});

test("non-admin cannot see the admin dashboard user list", async ({ page }) => {
  const suffix = Math.floor(Math.random() * 100000);
  await register(page, "plain diner", `plain${suffix}@jwt.com`, "diner");
  await page.goto("/admin-dashboard");
  await expect(page.getByPlaceholder("Filter users")).toHaveCount(0);
});

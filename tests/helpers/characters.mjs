/** Exercise the enabled import button and file picker as a user would. */
export async function importCharacter(page, files) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('#character-import').click(),
  ]);
  await chooser.setFiles(files);
}

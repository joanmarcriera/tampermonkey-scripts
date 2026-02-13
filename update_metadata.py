import os

base_url = "https://raw.githubusercontent.com/joanmarcriera/tampermonkey-scripts/main/servicenow/"
directory = "servicenow/"

for filename in os.listdir(directory):
    if filename.endswith(".user.js"):
        filepath = os.path.join(directory, filename)
        with open(filepath, 'r') as f:
            lines = f.readlines()

        new_lines = []
        in_header = False
        added_urls = False

        update_url = f"// @updateURL    {base_url}{filename}\n"
        download_url = f"// @downloadURL  {base_url}{filename}\n"

        for line in lines:
            if "// ==UserScript==" in line:
                in_header = True
                new_lines.append(line)
                continue

            if in_header and ("// ==/UserScript==" in line):
                if not added_urls:
                    new_lines.append(update_url)
                    new_lines.append(download_url)
                    added_urls = True
                in_header = False
                new_lines.append(line)
                continue

            if in_header:
                if "@updateURL" in line or "@downloadURL" in line:
                    continue # Skip existing ones if any, to overwrite

            new_lines.append(line)

        with open(filepath, 'w') as f:
            f.writelines(new_lines)
        print(f"Updated {filename}")

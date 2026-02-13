function cleanHtml(html) {
    const jsdom = require("jsdom");
    const { JSDOM } = jsdom;
    const dom = new JSDOM(`<div>${html}</div>`);
    const tempDiv = dom.window.document.querySelector("div");
    const allowedTags = ['B', 'STRONG', 'I', 'EM'];

    function process(node) {
        const children = Array.from(node.childNodes);
        for (const child of children) {
            if (child.nodeType === 1) { // Element
                if (allowedTags.includes(child.tagName)) {
                    while (child.attributes.length > 0) {
                        child.removeAttribute(child.attributes[0].name);
                    }
                    process(child);
                } else {
                    process(child);
                    while (child.firstChild) {
                        node.insertBefore(child.firstChild, child);
                    }
                    node.removeChild(child);
                }
            }
        }
    }

    process(tempDiv);
    return tempDiv.innerHTML;
}

const input = '<p>If you <b>cannot</b> login, try <i>clearing your cache</i>. <strong>This is important.</strong></p>';
console.log(cleanHtml(input));

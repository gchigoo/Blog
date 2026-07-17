const computedProperties = Object.freeze([
  'display', 'visibility', 'opacity', 'position', 'top', 'right', 'bottom', 'left',
  'zIndex', 'boxSizing', 'width', 'height', 'minWidth', 'maxWidth', 'minHeight',
  'maxHeight', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth',
  'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderTopStyle',
  'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle', 'borderTopColor',
  'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'borderRadius',
  'backgroundColor', 'backgroundImage', 'boxShadow', 'color', 'fontFamily',
  'fontSize', 'fontStyle', 'fontWeight', 'fontStretch', 'fontVariant', 'lineHeight',
  'letterSpacing', 'wordSpacing', 'textAlign', 'textDecorationLine', 'textTransform',
  'textIndent', 'textRendering', 'whiteSpace', 'wordBreak', 'overflowWrap',
  'overflowX', 'overflowY', 'transform', 'transformOrigin', 'flexBasis',
  'flexDirection', 'flexGrow', 'flexShrink', 'flexWrap', 'alignContent',
  'alignItems', 'alignSelf', 'justifyContent', 'justifyItems', 'justifySelf',
  'columnGap', 'rowGap', 'gridAutoColumns', 'gridAutoFlow', 'gridAutoRows',
  'gridTemplateColumns', 'gridTemplateRows', 'objectFit', 'objectPosition',
  'listStylePosition', 'listStyleType', 'tableLayout', 'borderCollapse'
]);

function collectLayoutSnapshot(page) {
  return page.evaluate(properties => {
    const round = value => Number(value.toFixed(3));
    const rectOf = element => {
      const rect = element.getBoundingClientRect();
      return {
        x: round(rect.x),
        y: round(rect.y),
        width: round(rect.width),
        height: round(rect.height),
        top: round(rect.top),
        right: round(rect.right),
        bottom: round(rect.bottom),
        left: round(rect.left)
      };
    };
    const pathOf = element => {
      const parts = [];
      let current = element;
      while (current && current !== document.body) {
        const siblings = Array.from(current.parentElement?.children || []);
        parts.push(`${current.tagName.toLowerCase()}:nth-child(${siblings.indexOf(current) + 1})`);
        current = current.parentElement;
      }
      return ['body', ...parts.reverse()].join(' > ');
    };
    const styleOf = (element, pseudo = null) => {
      const computed = getComputedStyle(element, pseudo);
      return Object.fromEntries(properties.map(property => [property, computed[property]]));
    };
    const pseudoOf = (element, pseudo) => {
      const computed = getComputedStyle(element, pseudo);
      if (!computed.content || ['none', 'normal'].includes(computed.content)) return null;
      return {
        content: computed.content,
        display: computed.display,
        color: computed.color,
        fontFamily: computed.fontFamily,
        fontSize: computed.fontSize,
        lineHeight: computed.lineHeight,
        position: computed.position
      };
    };
    const elements = Array.from(document.body.querySelectorAll('*'))
      .filter(element => !['SCRIPT', 'STYLE'].includes(element.tagName))
      .map(element => ({
        path: pathOf(element),
        tag: element.tagName.toLowerCase(),
        id: element.id,
        classes: Array.from(element.classList),
        hidden: element.hidden,
        rect: rectOf(element),
        client: { width: element.clientWidth, height: element.clientHeight },
        scroll: { width: element.scrollWidth, height: element.scrollHeight },
        style: styleOf(element),
        before: pseudoOf(element, '::before'),
        after: pseudoOf(element, '::after')
      }));
    const scrolling = document.scrollingElement;
    return {
      environment: {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        fonts: document.fonts.status,
        visualViewport: window.visualViewport ? {
          width: round(window.visualViewport.width),
          height: round(window.visualViewport.height),
          scale: round(window.visualViewport.scale)
        } : null
      },
      document: {
        clientWidth: document.documentElement.clientWidth,
        clientHeight: document.documentElement.clientHeight,
        scrollWidth: scrolling.scrollWidth,
        scrollHeight: scrolling.scrollHeight,
        bodyRect: rectOf(document.body),
        bodyStyle: styleOf(document.body)
      },
      elements
    };
  }, computedProperties);
}

module.exports = { collectLayoutSnapshot };

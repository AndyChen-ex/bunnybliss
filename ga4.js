// 布妮絲菓子工房 GA4 E-commerce event helpers
// Replace G-XXXXXXXXXX with your real Measurement ID from Google Analytics
const GA4_ID = 'G-XXXXXXXXXX';

window.bbGA = {
  // 查看商品詳情頁 (view_item)
  viewItem(product, categoryName) {
    if (!window.gtag) return;
    gtag('event', 'view_item', {
      currency: 'TWD',
      value: product.price,
      items: [{
        item_id: String(product.id),
        item_name: product.name,
        item_category: categoryName || '',
        price: product.price,
        quantity: 1,
      }]
    });
  },

  // 加入購物車 (add_to_cart)
  addToCart(name, price, qty, itemId, categoryName) {
    if (!window.gtag) return;
    gtag('event', 'add_to_cart', {
      currency: 'TWD',
      value: price * qty,
      items: [{
        item_id: itemId ? String(itemId) : name,
        item_name: name,
        item_category: categoryName || '',
        price: price,
        quantity: qty,
      }]
    });
  },

  // 完成購買 (purchase)
  purchase(order) {
    if (!window.gtag) return;
    gtag('event', 'purchase', {
      transaction_id: order.id,
      value: order.total,
      currency: 'TWD',
      shipping: order.shipping?.fee || 0,
      items: (order.items || []).map(item => ({
        item_id: item.name,
        item_name: item.name,
        price: item.price,
        quantity: item.qty,
      }))
    });
  }
};

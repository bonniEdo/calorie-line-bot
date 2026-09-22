    function compressPhotoLegacy(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('無法讀取照片'));
        reader.onload = () => {
          const image = new Image();
          image.onerror = () => reject(new Error('照片格式無法讀取'));
          image.onload = () => {
            try {
              const maxSide = 1280;
              const ratio = Math.min(1, maxSide / Math.max(image.width, image.height));
              const canvas = document.createElement('canvas');
              canvas.width = Math.max(1, Math.round(image.width * ratio));
              canvas.height = Math.max(1, Math.round(image.height * ratio));
              const context = canvas.getContext('2d');
              context.drawImage(image, 0, 0, canvas.width, canvas.height);
              resolve(canvas.toDataURL('image/jpeg', .76));
            } catch (error) { reject(new Error('無法處理照片，請換一張較小的照片再試。')); }
          };
          image.src = reader.result;
        };
        reader.readAsDataURL(file);
      });
    }
